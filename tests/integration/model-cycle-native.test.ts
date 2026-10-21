// @vitest-environment jsdom
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments";
import { PiRpcProcess } from "../../server/pi-rpc";
import { SessionManager } from "../../server/pi-runtime";
import { RuntimeController } from "../../server/runtime";
import { SessionCatalog } from "../../server/session-catalog";
import { AppStore } from "../../src/store";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "../server/fixtures/host-api";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "../server/fixtures/native-pi";
import { installFakeWebSocket } from "../web/helpers";

it.each([false, true])(
  "preserves the native cycle scope/default/hook order through AppStore, HTTP and RPC (scoped=%s)",
  async (scoped) => {
    const f = await nativePiWorkspace("inspire-cycle-native-", {
      defaultProjectTrust: "never",
      defaultProvider: "global-native",
      defaultModel: "a",
      defaultThinkingLevel: "medium",
      enabledModels: [
        "global-native/a",
        "global-native/b" + (scoped ? ":high" : ""),
      ],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      extensions: [resolve("tests/fixtures/pi-model-workflow-extension.ts")],
    });
    stubNativePiEnvironment(f.env);
    const events = join(f.root, "effects.jsonl"),
      hook = join(f.root, "hook.ts");
    vi.stubEnv("INSPIRE_MODEL_FIXTURE_EVENTS", join(f.root, "model-events"));
    await writeFile(
      hook,
      `import { appendFileSync } from "node:fs";
    export default pi => pi.on("model_select", (event, ctx) => {
      if (event.model.id !== "b") return;
      appendFileSync(${JSON.stringify(events)}, JSON.stringify({ entered: pi.getThinkingLevel(), source: event.source }) + "\\n");
      pi.setThinkingLevel("low");
    });`,
    );
    const manager = SessionManager.create(f.cwd, f.sessions);
    manager.appendModelChange("global-native", "a");
    manager.appendThinkingLevelChange("medium");
    manager.appendMessage({
      role: "user",
      content: "retained offline turn",
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "offline answer" }],
      api: "openai-completions",
      provider: "global-native",
      model: "a",
      thinkingLevel: "medium",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const catalog = new SessionCatalog(f.cwd),
      attachments = new AttachmentStore(join(f.root, "uploads"));
    const commands: string[] = [];
    const runtime = new RuntimeController(catalog, attachments, (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [...(options.args ?? []), "-e", hook],
      });
      const request = worker.request.bind(worker);
      worker.request = ((command, ...args) => {
        commands.push(String(command.type));
        return request(command, ...args);
      }) as typeof worker.request;
      return worker;
    });
    let host: Awaited<ReturnType<typeof hostApiFixture>> | undefined,
      store: AppStore | undefined;
    const realFetch = fetch;
    try {
      await runtime.openSession(manager.getSessionId());
      host = await hostApiFixture({ runtime });
      installFakeWebSocket();
      const controls: string[] = [];
      vi.stubGlobal("fetch", (async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/control/")) controls.push(url);
        const headers = new Headers(init?.headers);
        headers.set("Authorization", "Bearer " + token);
        return realFetch(new URL(url, host!.baseUrl), { ...init, headers });
      }) satisfies typeof fetch);
      store = new AppStore();
      await store.init(token);
      const before = commands.length;
      await store.cycleModel(1);
      expect(store.getState()).toMatchObject({
        model: { provider: "global-native", id: "b" },
        thinkingLevel: "low",
      });
      expect(controls).toEqual(["/api/control/model-cycle"]);
      expect(
        commands.slice(before).filter((type) => type === "cycle_model"),
      ).toHaveLength(1);
      expect(commands.slice(before)).not.toContain("set_model");
      expect(commands.slice(before)).not.toContain("set_thinking_level");
      expect(JSON.parse((await readFile(events, "utf8")).trim())).toEqual({
        entered: scoped ? "high" : "medium",
        source: "cycle",
      });
      const cycleCount = commands.filter(
        (type) => type === "cycle_model",
      ).length;
      await store.cycleModel(-1);
      expect(commands.filter((type) => type === "cycle_model")).toHaveLength(
        cycleCount,
      );
      expect(store.getState()).toMatchObject({
        model: { id: "b" },
        thinkingLevel: "low",
      });
      expect(store.getState().notices.at(-1)?.text).toContain(
        "forward model cycling",
      );
      const manual = commands.length;
      await store.setThinkingLevel("high");
      expect(store.getState().thinkingLevel).toBe("high");
      expect((await runtime.snapshot()).active?.thinkingLevel).toBe("high");
      expect(
        commands.slice(manual).filter((type) => type === "set_thinking_level"),
      ).toHaveLength(1);
      expect(
        await readFile(join(f.root, "model-events"), "utf8"),
      ).not.toContain(":request");
    } finally {
      (
        store as unknown as
          | { connectionController: { stop(): void } }
          | undefined
      )?.connectionController.stop();
      if (host) await closeHostApiFixture(host);
      else await runtime.close();
      await attachments.close();
      await rm(f.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
