import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { discoverTerminalProfiles } from "../../server/terminal-profiles.js";
import type { TerminalAttachment } from "../../server/terminal-service.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";
import { ensureTerminalShellIntegration } from "../../server/terminal-shell-integration.js";
import { decodeTerminalServerDataFrame } from "../../shared/terminal-contracts.js";
import {
  type TerminalCommandOutput,
  terminalBufferText,
  terminalCommandOutput,
} from "../../src/terminal-output.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");
const windows = process.platform === "win32";
const profiles = discoverTerminalProfiles().filter((profile) =>
  windows ? /^(pwsh|powershell)$/.test(profile.id) : profile.id === "bash",
);

it.each(profiles)(
  "$id: extracts native output through the production launcher and preserves shell input",
  async (profile) => {
    const root = await mkdtemp(join(tmpdir(), "inspire-native-output-"));
    const integration = join(root, "integration");
    await ensureTerminalShellIntegration(integration);
    if (windows) {
      // Model a binding installed by the user's profile before Inspire's hook.
      // Never touch the real profile or replace the generated integration.
      const path = join(integration, "powershell-integration.ps1");
      await writeFile(
        path,
        [
          "$global:InspireTestEnterCount = 0",
          "Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {",
          "  $global:InspireTestEnterCount++",
          "  [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
          "}",
          await readFile(path, "utf8"),
        ].join("\n"),
      );
    } else {
      await writeFile(
        join(root, ".bash_profile"),
        [
          "__inspire_test_prompt() { __inspire_test_prompt_status=$?; }",
          "PROMPT_COMMAND=__inspire_test_prompt",
          "trap 'case \"$BASH_COMMAND\" in *CHECK_DEBUG*) __inspire_test_debug_seen=yes ;; esac' DEBUG",
        ].join("\n"),
      );
    }

    const manager = new TerminalSessionManager({
      profiles: [profile],
      env: isolatedTestEnvironment(root),
      shellIntegrationDirectory: integration,
    });
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 100,
    });
    const ranges: TerminalCommandOutput[] = [];
    const commands: string[] = [];
    let start: Pick<TerminalCommandOutput, "start" | "startColumn"> | null =
      null;
    let prompts = 0;
    let tail = Promise.resolve();
    let attachment: TerminalAttachment | undefined;
    let sequence = 0;
    const write = (text: string) =>
      attachment!.writeInput(++sequence, Buffer.from(text));

    terminal.parser.registerOscHandler(6973, (value) => {
      const phase = value.split(";")[0];
      if (phase === "C1") {
        commands.push(decodeURIComponent(value.slice(3)));
        start = {
          start: terminal.registerMarker(0)!,
          startColumn: terminal.buffer.active.cursorX,
        };
      } else if (phase === "D" && start) {
        ranges.push({
          ...start,
          end: terminal.registerMarker(0)!,
          endColumn: terminal.buffer.active.cursorX,
        });
        start = null;
      } else if (phase === "A") {
        prompts++;
      }
      return true;
    });
    terminal.onData(write);

    try {
      const descriptor = await manager.create({
        cwd: root,
        profileId: profile.id,
        cols: 80,
        rows: 24,
      });
      attachment = await manager.attach(
        {
          terminalId: descriptor.id,
          clientId: "native-output-test",
          cols: 80,
          rows: 24,
        },
        {
          sendControl() {},
          sendData(frame) {
            const { data } = decodeTerminalServerDataFrame(frame);
            tail = tail.then(
              () =>
                new Promise<void>((resolve) => terminal.write(data, resolve)),
            );
          },
          close() {},
        },
      );
      await vi.waitFor(
        async () => {
          await tail;
          expect(terminalBufferText(terminal.buffer.normal)).toMatch(
            /[>$#] *$/,
          );
        },
        { timeout: 20_000 },
      );

      const samples = windows
        ? [
            {
              command:
                "[Console]::WriteLine(('SHORT'+'_A')); [Console]::WriteLine(('SHORT'+'_B'))",
              output: "SHORT_A\nSHORT_B",
            },
            {
              command:
                "& {\r[Console]::WriteLine(('MULTI'+'_A'))\r[Console]::WriteLine(('WRAP'+'_' + ('x' * 120)))\r}",
              output: "MULTI_A\nWRAP_" + "x".repeat(120),
            },
            {
              command:
                "[Console]::WriteLine(('CUSTOM'+'_' + $global:InspireTestEnterCount))",
              output: "CUSTOM_6",
            },
          ]
        : [
            {
              command: "printf '%s\\n' SHORT''_A SHORT''_B",
              output: "SHORT_A\nSHORT_B",
            },
            {
              command:
                "{\rprintf '%s\\n' MULTI''_A\rprintf '%s\\n' WRAP''_" +
                "x".repeat(120) +
                "\r}",
              output: "MULTI_A\nWRAP_" + "x".repeat(120),
            },
            {
              command: "printf '%s\\n' PIPE''_A | cat",
              output: "PIPE_A",
            },
            { command: "false", output: "" },
            {
              command: 'printf "PROMPT_%s\\n" "$__inspire_test_prompt_status"',
              output: "PROMPT_1",
            },
            {
              command:
                ': CHECK_DEBUG; printf "DEBUG_%s\\n" "$__inspire_test_debug_seen"',
              output: "DEBUG_yes",
            },
          ];
      for (const { command, output } of samples) {
        const previousPrompts = prompts;
        const previousRanges = ranges.length;
        write(command + "\r");
        await vi.waitFor(
          async () => {
            await tail;
            expect(prompts).toBeGreaterThan(previousPrompts);
            expect(terminalBufferText(terminal.buffer.normal)).toContain(
              output,
            );
          },
          { timeout: 20_000 },
        );
        expect(ranges).toHaveLength(previousRanges + 1);
        if (previousRanges === 0) expect(commands.at(-1)).toBe(command);
        expect(
          terminalCommandOutput(terminal.buffer.normal, ranges.at(-1)!),
        ).toBe(output);
      }

      await manager.remove(descriptor.id, true);
      // A tab can be closed before asynchronous ConPTY connection assigns a PID.
      // Exercise that boundary without waiting for shell output or attaching.
      const starting = await manager.create({
        cwd: root,
        profileId: profile.id,
      });
      await manager.remove(starting.id, true);
      expect(manager.list().terminals).toEqual([]);
    } finally {
      attachment?.detach();
      try {
        // Production close owns bounded PTY retirement; never force test exit.
        await manager.close();
      } finally {
        await tail;
        terminal.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
