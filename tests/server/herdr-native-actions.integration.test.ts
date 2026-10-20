import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "@lydell/node-pty";
import { expect, it, vi } from "vitest";
import {
  nativeActionFrame,
  piActivityDirectory,
} from "../../docs/examples/session-activity.js";
import type { HerdrClient } from "../../server/herdr-client.js";
import { HerdrNativeSession } from "../../server/herdr-native-session.js";
import { piInstallation } from "../../server/pi-runtime.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

it.skipIf(process.platform !== "linux")(
  "invokes native actions with remapped keys and below-editor widgets, then returns to the same terminal",
  async () => {
    const f = await nativePiWorkspace("inspire-native-actions-", {
      defaultProjectTrust: "never",
      packages: [],
      extensions: [],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    stubNativePiEnvironment(f.env);
    const sessionId = randomUUID(),
      sessionFile = join(f.sessions, sessionId + ".jsonl");
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
    await writeFile(
      join(f.agent, "keybindings.json"),
      JSON.stringify({
        "app.message.followUp": "ctrl+y",
        "app.interrupt": "ctrl+q",
      }),
    );
    await mkdir(join(f.agent, "prompts"));
    await writeFile(
      join(f.agent, "prompts", "fixture-template.md"),
      "Native template expanded: $1",
    );
    const shellStart = join(f.root, "shell-start"),
      shellGate = join(f.root, "shell-gate"),
      shellDone = join(f.root, "shell-done");
    const probe = join(f.root, "state.json"),
      extension = join(f.root, "probe.ts");
    await writeFile(
      extension,
      `
    import { writeFileSync } from "node:fs";
    export default pi => {
      let ctx, timer, aborted = false, commands = 0, handled = 0;
      const publish = () => ctx && writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
        id: ctx.sessionManager.getSessionId(), idle: ctx.isIdle(),
        pending: ctx.hasPendingMessages(), editor: ctx.ui.getEditorText(), aborted, commands, handled,
      }));
      pi.on("session_start", (_, context) => {
        ctx = context; ctx.ui.setWidget("status", ["────────────────", "Normal extension status", "────────────────"], { placement: "belowEditor" });
        timer = setInterval(publish, 25); timer.unref(); publish();
      });
      pi.registerCommand("fixture-draft", { handler: async (_, context) => {
        context.ui.setWidget("status", ["────────────────", "", "────────────────"], { placement: "belowEditor" });
        context.ui.setEditorText("Keep this real terminal draft"); publish();
      } });
      pi.registerCommand("fixture-command", { handler: async () => { commands++; publish(); } });
      pi.registerCommand("fixture-dialog", { handler: async (_, context) => { await context.ui.confirm("Native question", "Answer in the original terminal"); } });
      pi.on("input", event => { if (event.text === "Handled native input") { handled++; publish(); return { action: "handled" }; } });
      pi.on("agent_settled", (event, context) => { ctx = context; aborted = event.aborted; publish(); });
      pi.on("session_shutdown", () => clearInterval(timer));
    }
  `,
    );
    const terminal = spawn(
      process.execPath,
      [
        piInstallation.cliPath,
        "--no-extensions",
        "-e",
        resolve("tests/fixtures/pi-model-workflow-extension.ts"),
        "-e",
        resolve("docs/examples/session-activity.ts"),
        "-e",
        extension,
        "--no-skills",
        "--no-context-files",
        "--no-themes",
        "--no-tools",
        "--no-approve",
        "--session",
        sessionFile,
        "--provider",
        "global-native",
        "--model",
        "a",
      ],
      {
        cwd: f.cwd,
        cols: 100,
        rows: 35,
        name: "xterm-256color",
        env: {
          ...f.env,
          TERM: "xterm-256color",
          HERDR_ENV: "1",
          HERDR_PANE_ID: "native",
          HERDR_SOCKET_PATH: join(f.root, "unused-herdr"),
          INSPIRE_MODEL_FIXTURE_STREAM_DELAY_MS: "60000",
        } as Record<string, string>,
      },
    );
    let exited = false,
      output = "";
    const exit = new Promise<void>((done) =>
      terminal.onExit(() => {
        exited = true;
        done();
      }),
    );
    terminal.onData((data) => {
      output = (output + data).slice(-20_000);
    });
    type State = {
      id: string;
      idle: boolean;
      pending: boolean;
      editor: string;
      aborted: boolean;
      commands: number;
      handled: number;
    };
    const state = async () =>
      JSON.parse(await readFile(probe, "utf8")) as State;
    const report = async () => {
      const name = (await readdir(piActivityDirectory())).find((name) =>
        name.startsWith(terminal.pid + "-"),
      )!;
      return JSON.parse(
        await readFile(join(piActivityDirectory(), name), "utf8"),
      );
    };
    const paste = (text: string) =>
      terminal.write("\x1b[200~" + text + "\x1b[201~");
    const calls: string[] = [];
    const client: Pick<
      HerdrClient,
      "nativeAgentRequest" | "inspectPaneProcess"
    > = {
      inspectPaneProcess: async () => ({
        paneId: "native",
        foregroundProcessGroupId: terminal.pid,
        foregroundProcesses: [{ pid: terminal.pid, name: "pi", argv: ["pi"] }],
      }),
      nativeAgentRequest: async (_server, _pane, method, params = {}) => {
        calls.push(method);
        if (method === "agent.get")
          return {
            agent: {
              agent: "pi",
              pane_id: "native",
              agent_status: (await state()).idle ? "done" : "working",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: (await state()).id,
              },
            },
          };
        if (method === "pane.send_text") {
          paste(String(params.text));
          return {};
        }
        throw new Error("Unexpected key or screen operation: " + method);
      },
    };
    const native = new HerdrNativeSession(
      client,
      { serverId: "test", paneId: "native", pid: terminal.pid },
      sessionId,
      sessionFile,
    );
    try {
      await vi.waitFor(
        async () =>
          expect(await state()).toMatchObject({ idle: true, editor: "" }),
        { timeout: 15000 },
      );
      expect(output).toContain("Normal extension status");
      for (const command of [
        "! echo must-not-run",
        "!! echo must-not-run",
        "/quit",
        "/compact",
        "/reload",
      ])
        await expect(native.prompt(command)).rejects.toMatchObject({
          code: "NATIVE_ACTION_UNSUPPORTED",
        });
      expect(await state()).toMatchObject({ idle: true, commands: 0 });
      await native.prompt("/fixture-command");
      await vi.waitFor(async () => expect((await state()).commands).toBe(1));
      await native.prompt("/fixture-dialog");
      await vi.waitFor(async () =>
        expect((await report()).activity).toBe("blocked"),
      );
      await expect(
        native.prompt("Do not bypass the native question"),
      ).rejects.toMatchObject({ code: "NATIVE_INPUT_BLOCKED" });
      expect(output).toContain("Native question");
      terminal.write("\x1b");
      await vi.waitFor(async () =>
        expect((await report()).activity).toBe("idle"),
      );
      await native.prompt("First browser instruction");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false), {
        timeout: 10000,
      });
      await native.prompt("Follow up, not a terminal draft", "followUp");
      await vi.waitFor(async () =>
        expect(await state()).toMatchObject({
          idle: false,
          pending: true,
          editor: "",
        }),
      );
      await native.abort();
      await vi.waitFor(
        async () =>
          expect(await state()).toMatchObject({
            idle: true,
            aborted: true,
            pending: false,
          }),
        { timeout: 10000 },
      );
      expect((await state()).editor).toContain(
        "Follow up, not a terminal draft",
      );
      terminal.write("\x15");
      await vi.waitFor(async () => expect((await state()).editor).toBe(""));
      paste("/fixture-draft");
      terminal.write("\r");
      await vi.waitFor(async () =>
        expect((await state()).editor).toBe("Keep this real terminal draft"),
      );
      await expect(
        native.prompt("Must not alter the draft"),
      ).rejects.toMatchObject({ status: 409, code: "NATIVE_EDITOR_NOT_EMPTY" });
      expect((await state()).editor).toBe("Keep this real terminal draft");
      expect(await readFile(sessionFile, "utf8")).not.toContain(
        "Must not alter the draft",
      );
      terminal.write("\x15");
      await vi.waitFor(async () => expect((await state()).editor).toBe(""));
      // Native reload replaces the action context, not the process or session.
      const reportFile = join(
        piActivityDirectory(),
        (await readdir(piActivityDirectory())).find((name) =>
          name.startsWith(terminal.pid + "-"),
        )!,
      );
      const oldReceiver = JSON.parse(await readFile(reportFile, "utf8"))
        .nativeActions.receiverId;
      paste("/reload");
      terminal.write("\r");
      await vi.waitFor(
        async () =>
          expect(
            JSON.parse(await readFile(reportFile, "utf8")).nativeActions
              .receiverId,
          ).not.toBe(oldReceiver),
        { timeout: 15000 },
      );
      paste(nativeActionFrame(oldReceiver, randomUUID()));
      // The old frame is consumed, not inserted into the current editor.
      await native.prompt("Second browser run");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false));
      await native.prompt("Steer in this same run", "steer");
      await vi.waitFor(async () =>
        expect(await state()).toMatchObject({
          idle: false,
          pending: true,
          editor: "",
        }),
      );
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      expect((await state()).editor).toContain("Steer in this same run");
      terminal.write("\x15");
      await vi.waitFor(async () => expect((await state()).editor).toBe(""));
      paste("Continue directly in the original terminal");
      terminal.write("\r");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false));
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      await native.prompt("/fixture-template original-argument");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false));
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      expect(await readFile(sessionFile, "utf8")).toContain(
        "Native template expanded: original-argument",
      );
      await native.prompt("Handled native input");
      await vi.waitFor(async () => expect((await state()).handled).toBe(1));
      expect((await report()).nativeActions.result.status).toBe("invoked");
      expect(await state()).toMatchObject({ idle: true, pending: false });
      expect(await readFile(sessionFile, "utf8")).not.toContain(
        "Handled native input",
      );
      expect((await state()).id).toBe(sessionId);
      expect(await readFile(sessionFile, "utf8")).toContain(
        "Continue directly in the original terminal",
      );
      // ctx.abort is an agent operation, not TUI abortBash. An explicit user
      // shell continues until its own gate; this receipt must not claim otherwise.
      paste(
        `! printf started > "${shellStart}"; while [ ! -f "${shellGate}" ]; do sleep 0.03; done; printf finished > "${shellDone}"`,
      );
      terminal.write("\r");
      await vi.waitFor(async () =>
        expect(await readFile(shellStart, "utf8")).toBe("started"),
      );
      expect(native.interruptionScope).toBe("agent");
      await native.abort();
      await writeFile(shellGate, "");
      await vi.waitFor(async () =>
        expect(await readFile(shellDone, "utf8")).toBe("finished"),
      );
      expect(
        calls.every(
          (method) => method === "agent.get" || method === "pane.send_text",
        ),
      ).toBe(true);
      expect(exited).toBe(false);
    } finally {
      native.close();
      await writeFile(shellGate, "").catch(() => undefined);
      if (!exited) terminal.kill();
      await Promise.race([
        exit,
        new Promise<void>((done) => setTimeout(done, 2000)),
      ]);
      if (!exited) {
        terminal.kill("SIGKILL");
        await exit;
      }
      await rm(f.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  60000,
);
