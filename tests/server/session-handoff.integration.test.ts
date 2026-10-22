import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawn } from "@lydell/node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import { RuntimeController } from "../../server/runtime.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});
const fixture = (options = {}) => nativeSessionWorkbench(cleanup, options);

it.skipIf(process.platform !== "linux")(
  "hands only its session to a real native terminal and requires explicit ownership recheck",
  async () => {
    const f = await fixture({ workspaceName: "work's $folder" });
    const before = await readFile(f.path, "utf8");
    const response = await fetch(`${f.url}/api/sessions/execution`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ sessionId: f.id, target: "terminal" }),
    });
    expect(response.status).toBe(200);
    const released = (await response.json()) as {
      snapshot: { active: { readOnlyReason: string } };
      command: string;
    };
    expect(released.snapshot.active.readOnlyReason).toBe("terminal");
    expect(f.workers[0]!.available).toBe(false);
    const shell = await promisify(execFile)("sh", [
      "-c",
      `pi() { printf '%s\\n' "$PWD" "$@"; }; ${released.command}`,
    ]);
    expect(shell.stdout.trim().split("\n")).toEqual([
      f.workspace,
      "--session",
      f.path,
    ]);
    const reopened = new RuntimeController(
      f.catalog,
      new AttachmentStore(join(f.directory, "reopened-uploads")),
      () => {
        throw new Error("A handoff must not prewarm Pi");
      },
    ).setTerminalSessionStore(f.terminalStore);
    try {
      expect((await reopened.openSession(f.id)).active?.readOnlyReason).toBe(
        "terminal",
      );
      await f.runtime.openSession(f.id);
      expect(f.workers).toHaveLength(1);
    } finally {
      await reopened.close();
    }
    const marker = join(f.directory, "terminal-started.json"),
      extension = join(f.directory, "terminal-probe.ts");
    await writeFile(
      extension,
      `import {writeFileSync} from "node:fs"; export default pi => { pi.on("session_start", (_,ctx) => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ id:ctx.sessionManager.getSessionId(), file:ctx.sessionManager.getSessionFile() }))); };`,
    );
    const occupancy = new PiSessionOccupancy();
    f.runtime.setExternalSessionGuard((id, file) =>
      occupancy.assertWritable(id, file),
    );
    const terminal = spawn(
      process.execPath,
      [
        piInstallation.cliPath,
        "--no-extensions",
        "--extension",
        resolve("docs/examples/session-activity.ts"),
        "--extension",
        extension,
        "--no-skills",
        "--no-context-files",
        "--no-themes",
        "--no-tools",
        "--no-approve",
        "--session",
        f.path,
      ],
      {
        cwd: f.workspace,
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        env: {
          ...isolatedTestEnvironment(f.directory, f.environment),
          TERM: "xterm-256color",
        } as Record<string, string>,
      },
    );
    terminal.onData(() => {});
    let exited = false;
    const exit = new Promise<void>((done) =>
      terminal.onExit(() => {
        exited = true;
        done();
      }),
    );
    try {
      await vi.waitFor(
        async () =>
          expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
            id: f.id,
            file: f.path,
          }),
        { timeout: 10000 },
      );
      await vi.waitFor(async () =>
        expect(occupancy.assertWritable(f.id, f.path)).rejects.toMatchObject({
          code: "EXTERNAL_PI_WRITER_ACTIVE",
        }),
      );
      expect(
        (await f.runtime.setSessionExecution(f.id, "inspire")).active
          ?.readOnlyReason,
      ).toBe("external-active");
      expect(f.workers).toHaveLength(1);
    } finally {
      if (!exited) terminal.kill();
      await exit;
    }
    const continued = await f.runtime.setSessionExecution(f.id, "inspire");
    expect(continued.active?.readOnlyReason).toBeUndefined();
    expect(f.workers).toHaveLength(2);
    expect(await readFile(f.path, "utf8")).toContain(before.trim());
  },
);
