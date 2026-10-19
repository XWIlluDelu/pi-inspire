import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverTerminalProfiles } from "../../server/terminal-profiles.js";
import {
  ensureTerminalShellIntegration,
  integratedTerminalLaunch,
} from "../../server/terminal-shell-integration.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const pty = createRequire(import.meta.url)(
  "@lydell/node-pty",
) as typeof import("@lydell/node-pty");
const native =
  process.platform === "win32"
    ? undefined
    : discoverTerminalProfiles().find((profile) => profile.id === "bash")
        ?.shell;
const shells = native ? [native] : [];
const roots: string[] = [];
if (!shells.length)
  it.skip("requires an available native POSIX Bash shell", () => {});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-bash-'startup-"));
  roots.push(root);
  return {
    root,
    integration: join(root, "integration"),
    env: isolatedTestEnvironment(root, {
      ENV: join(root, "untouched-env-file"),
      HISTFILE: join(root, "history"),
      PROMPT_COMMAND: "fixture_inherited_prompt",
    }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const prompt = "__FIXTURE_PROMPT__ ";
const setup = [
  'PS1="__FIXTURE_PROMPT__ "',
  'fixture_inherited_prompt() { local status=$?; printf "INHERITED:%s\\n" "$status"; return "$status"; }',
  'fixture_prompt() { local status=$?; printf "CALLBACK:%s\\n" "$status"; return "$status"; }',
  'fixture_function() { printf "FUNCTION:%s\\n" "$fixture_local"; }',
  "fixture_local=retained",
  "shopt -s nullglob",
  "trap 'case \"$BASH_COMMAND\" in *fixture_debug_probe*) fixture_debug_seen=yes ;; esac' DEBUG",
];
async function session(
  shell: string,
  f: Fixture,
  args: string[],
  run: (terminal: {
    output: () => string;
    send: (command: string) => Promise<string>;
    exit: () => Promise<void>;
  }) => Promise<void>,
) {
  await ensureTerminalShellIntegration(f.integration, f.env);
  const launch = integratedTerminalLaunch(
    {
      id: "bash",
      label: "Bash",
      shell,
      args,
      available: true,
      isDefault: true,
    },
    f.integration,
    f.env,
  );
  expect(launch.env.HOME).toBe(f.root);
  expect(launch.env.ENV).toBe(f.env.ENV);
  const child = pty.spawn(shell, launch.args, {
    cwd: f.root,
    env: Object.fromEntries(
      Object.entries(launch.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    cols: 120,
    rows: 24,
    name: "xterm-256color",
  });
  let output = "",
    exited = false,
    exitCode: number | undefined;
  const data = child.onData((value) => {
    output += value;
  });
  const exit = child.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
  });
  const waitPrompt = async (previous = 0) => {
    await vi.waitFor(
      () => {
        expect(output.split(prompt).length - 1).toBeGreaterThan(previous);
        expect(output.endsWith(prompt)).toBe(true);
      },
      { timeout: 5000 },
    );
  };
  try {
    await waitPrompt();
    await run({
      output: () => output,
      async send(command) {
        const start = output.length,
          prompts = output.split(prompt).length - 1;
        child.write(command + "\r");
        await waitPrompt(prompts);
        return output.slice(start);
      },
      async exit() {
        child.write("exit 7\r");
        await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000 });
        expect(exitCode).toBe(7);
      },
    });
  } finally {
    if (!exited) {
      child.kill();
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000 });
    }
    data.dispose();
    exit.dispose();
  }
}

describe.each(shells)("native Bash startup: %s", (shell) => {
  it.each([".bash_profile", ".bash_login", ".profile"])(
    "keeps true login, native %s precedence, shell state and one native logout",
    async (selected) => {
      const f = await fixture();
      const profiles = [".bash_profile", ".bash_login", ".profile"];
      const chosen = profiles.indexOf(selected);
      for (const [index, file] of profiles.entries()) {
        if (index < chosen) continue;
        await writeFile(
          join(f.root, file),
          index === chosen
            ? [
                ...setup,
                'printf "SELECTED:' + file + ':HOME=%s\\n" "$HOME"',
                'if shopt -q login_shell; then printf "PROFILE_LOGIN=yes\\n"; fi',
                'PROMPT_COMMAND="${PROMPT_COMMAND}; fixture_prompt"',
              ].join("\n")
            : 'printf "WRONG_PROFILE\\n"\n',
        );
      }
      await writeFile(join(f.root, ".bashrc"), 'printf "UNREQUESTED_RC\\n"\n');
      await writeFile(
        join(f.root, ".bash_logout"),
        'printf "NATIVE_LOGOUT:%s\\n" "$fixture_local"\n',
      );
      const original = await readFile(join(f.root, selected), "utf8");
      await session(shell, f, ["-l"], async (terminal) => {
        expect(terminal.output()).toContain("PROFILE_LOGIN=yes");
        expect(terminal.output()).toContain(
          "SELECTED:" + selected + ":HOME=" + f.root,
        );
        expect(terminal.output()).not.toMatch(/WRONG_PROFILE|UNREQUESTED_RC/);
        await terminal.send("false");
        expect(terminal.output()).toContain("INHERITED:1");
        expect(terminal.output()).toContain("CALLBACK:1");
        await terminal.send(": fixture_debug_probe");
        const state = await terminal.send(
          'fixture_function; printf "STATE:%s:%s:%s:%s\\n" "$HOME" "$ENV" "$fixture_debug_seen" "$(shopt -q nullglob && printf yes)"',
        );
        expect(state).toContain("FUNCTION:retained");
        expect(state).toContain(
          "STATE:" + f.root + ":" + f.env.ENV + ":yes:yes",
        );
        const markers = [
          ...terminal.output().matchAll(/\x1b\]6973;C1;([^\x07]*)\x07/gu),
        ].map((match) => decodeURIComponent(match[1]!));
        expect(markers).toContain("false");
        expect(markers).toEqual(
          expect.arrayContaining([
            expect.stringContaining(": fixture_debug_probe"),
          ]),
        );
        expect(
          markers.every((value) => !value.includes("bash-login-init.sh")),
        ).toBe(true);
        await terminal.exit();
        expect(
          terminal.output().match(/NATIVE_LOGOUT:retained/gu),
        ).toHaveLength(1);
        expect(terminal.output().match(/SELECTED:/gu)).toHaveLength(1);
      });
      expect(await readFile(join(f.root, selected), "utf8")).toBe(original);
    },
  );

  it("keeps nonlogin bashrc startup without login profiles or logout", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, ".bash_profile"),
      'printf "WRONG_PROFILE\\n"\n',
    );
    await writeFile(join(f.root, ".bash_logout"), 'printf "WRONG_LOGOUT\\n"\n');
    await writeFile(
      join(f.root, ".bashrc"),
      [...setup, 'printf "NATIVE_RC\\n"', "PROMPT_COMMAND=fixture_prompt"].join(
        "\n",
      ),
    );
    await session(shell, f, [], async (terminal) => {
      expect(terminal.output().match(/NATIVE_RC/gu)).toHaveLength(1);
      const state = await terminal.send(
        'if shopt -q login_shell; then printf "LOGIN=yes\\n"; else printf "LOGIN=no\\n"; fi; fixture_function',
      );
      expect(state).toContain("LOGIN=no");
      expect(state).toContain("FUNCTION:retained");
      expect(terminal.output()).toContain("\x1b]6973;C1;");
      await terminal.exit();
      expect(terminal.output()).not.toMatch(/WRONG_PROFILE|WRONG_LOGOUT/);
    });
  });

  it.each(["replaced", "reordered", "readonly-prompt", "readonly-ps0"])(
    "leaves %s prompt configuration as an ordinary PTY without false markers",
    async (mode) => {
      const f = await fixture();
      await writeFile(
        join(f.root, ".bash_profile"),
        [
          ...setup,
          mode === "replaced"
            ? "PROMPT_COMMAND=fixture_prompt"
            : mode === "reordered"
              ? 'PROMPT_COMMAND="fixture_prompt; $PROMPT_COMMAND"'
              : 'PROMPT_COMMAND="${PROMPT_COMMAND}; fixture_prompt"',
          mode === "readonly-prompt"
            ? "readonly PROMPT_COMMAND"
            : mode === "readonly-ps0"
              ? "readonly PS0=user-prefix"
              : ":",
        ].join("\n"),
      );
      await session(shell, f, ["-l"], async (terminal) => {
        await terminal.send("false");
        expect(terminal.output()).toContain("CALLBACK:1");
        const state = await terminal.send(
          'fixture_function; printf "HOME_ENV:%s:%s\\n" "$HOME" "$ENV"',
        );
        expect(state).toContain("FUNCTION:retained");
        expect(state).toContain("HOME_ENV:" + f.root + ":" + f.env.ENV);
        expect(terminal.output()).not.toMatch(
          /\x1b\]6973;|readonly variable|command not found/,
        );
        await terminal.exit();
      });
    },
  );
});
