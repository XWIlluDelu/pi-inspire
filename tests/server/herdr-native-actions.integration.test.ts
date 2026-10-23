import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "@lydell/node-pty";
import { expect, it, vi } from "vitest";
import {
  nativeActionFrame,
  piActivityDirectory,
} from "../../extensions/inspire-session-bridge.js";
import { AttachmentStore } from "../../server/attachments.js";
import type { HerdrClient } from "../../server/herdr-client.js";
import { HerdrNativeSession } from "../../server/herdr-native-session.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

it.skipIf(process.platform !== "linux")(
  "invokes native actions with remapped keys and below-editor widgets, then returns to the same terminal",
  async () => {
    const f = await nativePiWorkspace("inspire-native-actions-", {
      defaultProjectTrust: "never",
      defaultThinkingLevel: "high",
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
    import { renameSync, writeFileSync } from "node:fs";
    export default pi => {
      let ctx, timer, aborted = false, commands = 0, handled = 0, images = [], redirect = false;
      let slowArmed = false, slowStarted = false, slowCancelled = false;
      pi.registerProvider("native-plain", {
        api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic",
        models: Array.from({length: 300}, (_, n) => ({id: "plain-" + n, name: "Native-only " + n + " " + "name".repeat(24), reasoning: false})),
      });
      pi.on("model_select", async (event, context) => {
        ctx = context;
        if (event.source === "set" && event.model.provider === "global-native") {
          if (event.model.id === "a" && redirect)
            await pi.setModel(ctx.modelRegistry.find("global-native", "b"));
          if (event.model.id === "b") pi.setThinkingLevel("low");
        }
        publish();
      });
      pi.registerCommand("fixture-redirect", {handler: async () => {redirect = true;}});
      pi.registerCommand("fixture-slow-catalog", {handler: async () => {
        const refresh = ctx.modelRegistry.refresh.bind(ctx.modelRegistry);
        ctx.modelRegistry.refresh = async ({signal}) => {
          ctx.modelRegistry.refresh = refresh;
          slowStarted = true; publish();
          return new Promise((_, reject) => {
            const cancel = () => { slowCancelled = true; publish(); reject(signal.reason); };
            signal.addEventListener("abort", cancel, {once: true});
            if (signal.aborted) cancel();
          });
        };
        slowArmed = true; publish();
      }});
      const publish = () => {
        if (!ctx) return;
        writeFileSync(${JSON.stringify(probe + ".tmp")}, JSON.stringify({
          id: ctx.sessionManager.getSessionId(), idle: ctx.isIdle(),
          pending: ctx.hasPendingMessages(), editor: ctx.ui.getEditorText(), aborted, commands, handled, images,
          slowArmed, slowStarted, slowCancelled,
          model: ctx.model ? {provider: ctx.model.provider, id: ctx.model.id} : null, thinkingLevel: pi.getThinkingLevel(),
        }));
        renameSync(${JSON.stringify(probe + ".tmp")}, ${JSON.stringify(probe)});
      };
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
      pi.on("before_agent_start", event => { images = event.images ?? []; publish(); });
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
        resolve("extensions/inspire-session-bridge.ts"),
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
      slowArmed: boolean;
      slowStarted: boolean;
      slowCancelled: boolean;
      images: Array<{ type: string; data: string; mimeType: string }>;
      model: { provider: string; id: string } | null;
      thinkingLevel: string;
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
        if (method === "agent.get") {
          const current = await state();
          return {
            agent: {
              agent: "pi",
              pane_id: "native",
              agent_status: current.idle ? "done" : "working",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: current.id,
              },
            },
          };
        }
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
    const attachments = new AttachmentStore(join(f.root, "uploads"));
    const runtime = new RuntimeController(
      new SessionCatalog(f.cwd),
      attachments,
      () => {
        throw new Error("Must not start another Pi");
      },
    ).setExternalSessionConnector(async () => native);
    try {
      await vi.waitFor(
        async () => {
          expect(await state()).toMatchObject({ idle: true, editor: "" });
          // Publishing state does not wait for the separate PTY output stream.
          expect(output).toContain("Normal extension status");
        },
        { timeout: 15000 },
      );
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
      await runtime.openSession(sessionId);
      const catalog = await runtime.refreshModels(sessionId);
      expect(catalog.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "global-native", id: "b" }),
          expect.objectContaining({
            provider: "global-router",
            id: "auto",
            virtual: true,
          }),
          expect.objectContaining({
            provider: "native-plain",
            id: "plain-299",
          }),
        ]),
      );
      expect(JSON.stringify(catalog.models).length).toBeGreaterThan(16_384);
      expect(JSON.stringify(catalog.models)).not.toMatch(
        /baseUrl|apiKey|headers/u,
      );
      expect(
        (await runtime.snapshot(sessionId)).sessionStatuses[sessionId],
      ).toMatchObject({
        external: true,
        nativeModelControls: true,
      });
      const switched = await runtime.setModel(sessionId, "global-native", "b");
      expect(switched).toMatchObject({
        model: { provider: "global-native", id: "b" },
        thinkingLevel: "low",
      });
      await native.prompt("/fixture-redirect");
      expect(
        await runtime.setModel(sessionId, "global-native", "a"),
      ).toMatchObject({
        model: { provider: "global-native", id: "b" },
        thinkingLevel: "low",
      });
      await runtime.setModel(sessionId, "global-router", "auto");
      expect(await runtime.setThinkingLevel(sessionId, "max")).toMatchObject({
        thinkingLevel: "high",
      });
      expect(
        await runtime.setModel(sessionId, "native-plain", "plain-0"),
      ).toMatchObject({
        model: { provider: "native-plain", id: "plain-0", reasoning: false },
        thinkingLevel: "off",
      });
      await runtime.setModel(sessionId, "global-native", "b");
      const nativeSnapshot = await runtime.snapshot(sessionId);
      expect(nativeSnapshot.active).toMatchObject({
        model: { provider: "global-native", id: "b" },
        thinkingLevel: "low",
        availableModels: expect.arrayContaining([
          expect.objectContaining({
            provider: "native-plain",
            id: "plain-299",
          }),
        ]),
      });
      expect((await state()).thinkingLevel).toBe("low");
      expect(
        JSON.parse(await readFile(join(f.agent, "settings.json"), "utf8"))
          .defaultThinkingLevel,
      ).toBe("high");
      await native.prompt("/fixture-command");
      await vi.waitFor(async () => expect((await state()).commands).toBe(1));
      await native.prompt("/fixture-dialog");
      await vi.waitFor(async () => {
        expect((await report()).activity).toBe("blocked");
        expect(output).toContain("Native question");
      });
      await expect(
        native.prompt("Do not bypass the native question"),
      ).rejects.toMatchObject({ code: "NATIVE_INPUT_BLOCKED" });
      terminal.write("\x1b");
      await vi.waitFor(async () =>
        expect((await report()).activity).toBe("idle"),
      );
      await native.prompt("/fixture-slow-catalog");
      await vi.waitFor(async () =>
        expect((await state()).slowArmed).toBe(true),
      );
      await native.prompt("First browser instruction");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false), {
        timeout: 10000,
      });
      await expect(
        runtime.nativeCommand({ sessionId, command: "reload" }),
      ).rejects.toMatchObject({
        code: "NATIVE_ACTION_UNSUPPORTED",
        message: "Run /reload in the original Pi terminal.",
      });
      expect((await runtime.snapshot(sessionId)).runState).toBe("running");
      // These public native controls stay supported during model work.
      expect(await runtime.setThinkingLevel(sessionId, "medium")).toMatchObject(
        { thinkingLevel: "medium" },
      );
      expect(
        await runtime.setModel(sessionId, "global-native", "b"),
      ).toMatchObject({ thinkingLevel: "high" });
      expect((await state()).idle).toBe(false);
      await native.prompt("Follow up, not a terminal draft", "followUp");
      await vi.waitFor(async () =>
        expect(await state()).toMatchObject({
          idle: false,
          pending: true,
          editor: "",
        }),
      );
      // A pending directory read must not delay Stop or steal its receipt.
      const slowCatalog = runtime.refreshModels(sessionId);
      const cancelled =
        expect(slowCatalog).rejects.toThrow("cancelled by Stop");
      await vi.waitFor(async () =>
        expect((await state()).slowStarted).toBe(true),
      );
      await runtime.abort(sessionId);
      await cancelled;
      expect((await state()).slowCancelled).toBe(true);
      await vi.waitFor(
        async () =>
          expect(await state()).toMatchObject({
            idle: true,
            aborted: true,
            pending: false,
          }),
        { timeout: 10000 },
      );
      await vi.waitFor(async () =>
        expect((await native.read())?.taskRuns?.settled.at(-1)?.outcome).toBe(
          "aborted",
        ),
      );
      expect((await state()).editor).toContain(
        "Follow up, not a terminal draft",
      );
      const restoredDraft = (await state()).editor;
      await native.prompt("Browser input after Stop");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false));
      expect((await state()).editor).toBe(restoredDraft);
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      terminal.write("\x15");
      await vi.waitFor(async () => expect((await state()).editor).toBe(""));
      paste("/fixture-draft");
      terminal.write("\r");
      await vi.waitFor(async () =>
        expect((await state()).editor).toBe("Keep this real terminal draft"),
      );
      await native.prompt("Must not alter the draft");
      await vi.waitFor(async () => expect((await state()).idle).toBe(false));
      expect((await state()).editor).toBe("Keep this real terminal draft");
      expect(await readFile(sessionFile, "utf8")).toContain(
        "Must not alter the draft",
      );
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      // Exercise the complete Host attachment path, not just a path in prompt text.
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "base64",
      );
      const uploaded = await attachments.add({
        originalname: "pixel.png",
        mimetype: "image/png",
        size: image.length,
        buffer: image,
      } as Express.Multer.File);
      await runtime.openSession(sessionId);
      await runtime.prompt({
        sessionId,
        message: "Inspect this image",
        attachmentIds: [uploaded.id],
      });
      await vi.waitFor(async () => {
        expect((await state()).images).toEqual([
          {
            type: "image",
            data: image.toString("base64"),
            mimeType: "image/png",
          },
        ]);
      });
      expect((await state()).editor).toBe("Keep this real terminal draft");
      await expect(attachments.imagePreview(uploaded.id)).rejects.toMatchObject(
        { status: 404 },
      );
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
      terminal.write("\x15");
      await vi.waitFor(async () => expect((await state()).editor).toBe(""));
      await vi.waitFor(async () =>
        expect(await readFile(sessionFile, "utf8")).toContain(
          image.toString("base64"),
        ),
      );
      const history = await runtime.composerHistory(sessionId, 0);
      const recalled = history.entries.find(
        (entry) => entry.images.length > 0,
      )!;
      expect(recalled.images).toHaveLength(1);
      await runtime.prompt({
        sessionId,
        message: "",
        historyArtifacts: {
          viewId: history.viewId,
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: recalled.images.map((image) => image.reference),
          fileReferences: [],
        },
      });
      await vi.waitFor(async () => {
        expect((await state()).idle).toBe(false);
        expect((await state()).images).toEqual([
          {
            type: "image",
            data: image.toString("base64"),
            mimeType: "image/png",
          },
        ]);
      });
      await native.abort();
      await vi.waitFor(async () => expect((await state()).idle).toBe(true));
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
      expect(await runtime.setThinkingLevel(sessionId, "medium")).toMatchObject(
        { thinkingLevel: "medium" },
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
      await runtime.close();
      await attachments.close();
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
