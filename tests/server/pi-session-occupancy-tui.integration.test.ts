import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "@lydell/node-pty";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

it.skipIf(process.platform !== "linux")(
  "continues a viewed session after its real TUI exits without reopening or replaying input",
  async () => {
    const f = await nativePiWorkspace("inspire-tui-release-", {
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    stubNativePiEnvironment(f.env);
    const sessionId = randomUUID();
    const sessionFile = join(f.sessions, sessionId + ".jsonl");
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: f.cwd,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    const modelArgs = [
      "--provider",
      "global-native",
      "--model",
      "a",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-themes",
      "--no-prompt-templates",
      "--no-tools",
      "--no-approve",
      "-e",
      resolve("tests/fixtures/pi-model-workflow-extension.ts"),
    ];
    const terminal = spawn(
      process.execPath,
      [
        piInstallation.cliPath,
        "--session",
        sessionFile,
        ...modelArgs,
        "-e",
        resolve("docs/examples/session-activity.ts"),
      ],
      {
        cwd: f.cwd,
        cols: 100,
        rows: 35,
        name: "xterm-256color",
        env: { ...f.env, TERM: "xterm-256color" } as Record<string, string>,
      },
    );
    let exited = false;
    let output = "";
    const exit = new Promise<void>((done) =>
      terminal.onExit(() => {
        exited = true;
        done();
      }),
    );
    terminal.onData((data) => {
      output = (output + data).slice(-8_000);
    });
    const attachments = new AttachmentStore(join(f.root, "uploads"), null, {
      sweepIntervalMs: 0,
    });
    const create = vi.fn(
      (options) =>
        new PiRpcProcess({
          ...options,
          args: [...(options.args ?? []), ...modelArgs],
        }),
    );
    const guard = new PiSessionOccupancy();
    const runtime = new RuntimeController(
      new SessionCatalog(f.cwd),
      attachments,
      create,
    ).setExternalSessionGuard((id, file) => guard.assertWritable(id, file));
    const release = runtime.retainSessionView(sessionId);
    try {
      await vi.waitFor(
        () =>
          expect(
            guard.assertWritable(sessionId, sessionFile),
          ).rejects.toMatchObject({
            code: "EXTERNAL_PI_WRITER_ACTIVE",
          }),
        { timeout: 10_000 },
      );
      await runtime.openSession(sessionId);
      await vi.waitFor(async () =>
        expect((await runtime.snapshot(sessionId)).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      expect(create).not.toHaveBeenCalled();
      const view = (await runtime.snapshot(sessionId)).active!.transcriptPage!
        .viewId;
      terminal.write("/quit\r");
      await vi.waitFor(() => expect(exited, output).toBe(true), {
        timeout: 10_000,
      });
      await exit;
      await vi.waitFor(
        async () => {
          const snapshot = await runtime.snapshot(sessionId);
          expect(snapshot.active?.runtimeSettings).toBeDefined();
          expect(snapshot.active?.readOnlyReason).toBeUndefined();
          expect(snapshot.active?.transcriptPage?.viewId).toBe(view);
        },
        { timeout: 10_000 },
      );
      expect(create).toHaveBeenCalledOnce();
      expect(await readFile(sessionFile, "utf8")).not.toContain(
        '"role":"user"',
      );
      await runtime.prompt({
        sessionId,
        message: "Continue after leaving the terminal",
      });
      await vi.waitFor(
        async () =>
          expect(await readFile(sessionFile, "utf8")).toContain(
            "global physical a reply",
          ),
        { timeout: 10_000 },
      );
    } finally {
      release();
      await runtime.close();
      await attachments.close();
      if (!exited) terminal.kill();
      await exit;
      vi.unstubAllEnvs();
      await rm(f.root, { recursive: true, force: true });
    }
  },
  60_000,
);
