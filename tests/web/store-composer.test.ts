// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeSettings } from "../../shared/contracts";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
} from "./helpers";

import { baseRoutes, initStore } from "./store-fixture";

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it("rolls back to the truthful level and resyncs when the API rejects the change", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking"))
        return { status: 500, body: { error: "unsupported level" } };
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return { body: activeSnapshot({ thinkingLevel: "medium" }) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().thinkingLevel).toBe("medium");

    await store.setThinkingLevel("xhigh");
    // rolled back: the UI must not claim a level the runtime rejected
    expect(store.getState().thinkingLevel).toBe("medium");
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" && notice.text === "unsupported level",
        ),
    ).toBe(true);
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(0));
  });

  it("does not let an older refusal undo a newer accepted level", async () => {
    const xhigh = deferred<RouteResponse>();
    const low = deferred<RouteResponse>();
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) {
        const body = jsonBody(init) as { level: string };
        return body.level === "xhigh" ? xhigh.promise : low.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const older = store.setThinkingLevel("xhigh");
    const newer = store.setThinkingLevel("low");
    low.resolve({ body: { ok: true } });
    await newer;
    xhigh.resolve({ status: 500, body: { error: "unsupported level" } });
    await older;

    expect(store.getState().thinkingLevel).toBe("low");
  });
});

describe("composer session partitions", () => {
  beforeEach(() => installFakeWebSocket());

  it("keeps staged artifacts with their session across switches and sends", async () => {
    let uploads = 0;
    const promptBodies: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/attachments")) {
        uploads += 1;
        return {
          body: {
            attachments: [
              {
                id: `att-${uploads}`,
                fileName: `file-${uploads}.txt`,
                mimeType: "text/plain",
                size: 5,
                kind: "file",
              },
            ],
          },
        };
      }
      if (url.startsWith("/api/prompt")) {
        promptBodies.push(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.addFiles([
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
    store.addProjectFile("src/index.ts");
    expect(store.getState().attachments).toHaveLength(1);

    // Switching sessions swaps the visible slice; session B starts clean.
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "B" }),
    });
    expect(store.getState().attachments).toEqual([]);
    expect(store.getState().projectFiles).toEqual([]);

    // A send from B must not carry A's staged artifacts.
    await store.sendPrompt("from B");
    expect(promptBodies.at(-1)).toMatchObject({
      sessionId: "s2",
      message: "from B",
    });

    // Switching back restores A's staged work untouched.
    socket.emit({ type: "snapshot", data: activeSnapshot() });
    expect(store.getState().attachments.map((item) => item.fileName)).toEqual([
      "file-1.txt",
    ]);
    expect(store.getState().projectFiles).toEqual(["src/index.ts"]);
  });
});

describe("Pi native command dispatch", () => {
  beforeEach(() => installFakeWebSocket());

  it.each(["compact", "export", "reload"])(
    "shows /%s running without invented progress guidance",
    async (command) => {
      const native = deferred<RouteResponse>();
      installFetch((url, init) => {
        if (url.startsWith("/api/control/native-command"))
          return native.promise;
        return baseRoutes(url, init);
      });
      const { store } = await initStore();

      await store.sendPrompt(`/${command}`);
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command,
        status: "running",
        message: "",
      });

      native.resolve({
        body: { command, outcome: "completed", message: "Host result" },
      });
      await vi.waitFor(() =>
        expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
          status: "success",
          message: "Host result",
        }),
      );
    },
  );

  it("routes host commands away from the model and retains their result", async () => {
    const nativeBodies: Record<string, unknown>[] = [];
    let promptCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeBodies.push(jsonBody(init));
        return {
          body: {
            command: "compact",
            outcome: "completed",
            message: "Context compacted from 12,640 to about 4,200 tokens.",
            details: [
              { label: "Before", value: "12,640 tokens" },
              { label: "After (estimate)", value: "4,200 tokens" },
            ],
          },
        };
      }
      if (url.startsWith("/api/prompt")) {
        promptCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(
      store.sendPrompt("/compact focus on decisions"),
    ).resolves.toEqual({ accepted: true, historyEntry: null });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "compact",
        status: "success",
        message: "Context compacted from 12,640 to about 4,200 tokens.",
      }),
    );
    expect(nativeBodies).toEqual([
      {
        sessionId: "s1",
        command: "compact",
        argument: "focus on decisions",
      },
    ]);
    expect(promptCount).toBe(0);
  });

  it("keeps an RPC acceptance-unknown Host result non-retryable", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command"))
        return {
          status: 504,
          body: {
            error: "Pi export outcome is unknown",
            code: "PI_RPC_OUTCOME_UNKNOWN",
          },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(store.sendPrompt("/export")).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "export",
        status: "warning",
        message: expect.stringContaining("could not confirm"),
      }),
    );
  });

  it("does not evict an in-flight Host receipt from bounded command history", async () => {
    const native = deferred<RouteResponse>();
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) return native.promise;
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.sendPrompt("/compact");
    await store.sendPrompt("/session");
    await store.sendPrompt("/hotkeys");
    await store.sendPrompt("/quit");
    await store.sendPrompt("/login");

    expect(store.getState().commandActivities.s1).toHaveLength(4);
    expect(store.getState().commandActivities.s1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "compact", status: "running" }),
        expect.objectContaining({
          command: "login",
          status: "warning",
          details: [{ label: "Run in Pi", value: "/login" }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: "/login",
          },
        }),
      ]),
    );

    native.resolve({
      body: {
        command: "compact",
        outcome: "completed",
        message: "Context compacted.",
      },
    });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: "compact", status: "success" }),
        ]),
      ),
    );
  });

  it("preserves Pi's dynamic-command precedence over built-in name collisions", async () => {
    const promptBodies: Record<string, unknown>[] = [];
    let nativeCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      if (url.startsWith("/api/prompt")) {
        promptBodies.push(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        commands: [
          {
            name: "model",
            description: "Extension-owned model command",
            source: "extension",
          },
        ],
      }),
    });

    expect(store.isNativeCommand("/model custom")).toBe(false);
    await expect(store.sendPrompt("/model custom")).resolves.toMatchObject({
      accepted: true,
    });
    await expect(store.sendPrompt("/model\tcustom")).resolves.toMatchObject({
      accepted: true,
    });
    expect(promptBodies).toHaveLength(2);
    expect(promptBodies.at(-1)).toMatchObject({
      sessionId: "s1",
      message: "/model custom",
    });
    expect(nativeCount).toBe(0);
  });

  it("keeps unknown slash and shell-like input out of model delivery", async () => {
    let promptCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/prompt")) {
        promptCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(store.sendPrompt("/does-not-exist")).resolves.toBe(false);
    await expect(store.sendPrompt("/MODEL")).resolves.toBe(false);
    await expect(store.sendPrompt("!rm -rf build")).resolves.toBe(false);
    await expect(store.sendPrompt("! echo safe")).resolves.toBe(false);
    expect(promptCount).toBe(0);
    expect(store.getState().commandActivities.s1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "does-not-exist",
          status: "error",
        }),
        expect.objectContaining({
          command: "bash",
          status: "warning",
          action: { kind: "open-terminal", label: "Open project terminal" },
        }),
      ]),
    );
  });

  it("declines state-changing native commands while Pi is busy", async () => {
    let nativeCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeCount += 1;
        return {
          body: {
            command: "compact",
            outcome: "completed",
            message: "Context compacted.",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const running = activeSnapshot();
    running.runState = "running";
    running.sessionStatuses.s1 = { runState: "running" };
    socket.emit({ type: "snapshot", data: running });

    await expect(store.sendPrompt("/compact")).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    expect(nativeCount).toBe(0);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "compact",
      status: "warning",
      message: expect.stringContaining("Wait for the current Pi operation"),
    });
  });

  it("updates Pi delivery and resilience settings through typed controls", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let runtimeSettings: PiRuntimeSettings = {
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
    };
    installFetch((url, init) => {
      if (url.startsWith("/api/control/")) {
        const body = jsonBody(init);
        requests.push({ path: url, body });
        runtimeSettings = {
          ...runtimeSettings,
          ...(url.endsWith("auto-compaction")
            ? { autoCompactionEnabled: body.enabled as boolean }
            : url.endsWith("auto-retry")
              ? { autoRetryEnabled: body.enabled as boolean }
              : url.endsWith("steering-mode")
                ? { steeringMode: body.mode as "all" | "one-at-a-time" }
                : { followUpMode: body.mode as "all" | "one-at-a-time" }),
        };
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({ runtimeSettings }),
          }),
        };
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ runtimeSettings }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.setAutoCompaction(false);
    await store.setAutoRetry(false);
    await store.setSteeringMode("one-at-a-time");
    await store.setFollowUpMode("all");

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/control/auto-compaction",
      "/api/control/auto-retry",
      "/api/control/steering-mode",
      "/api/control/follow-up-mode",
    ]);
    expect(store.getState().runtimeSettings).toEqual({
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "one-at-a-time",
      followUpMode: "all",
    });
  });

  it.each([
    ["autoRetryEnabled", "setAutoRetry", false, true],
    ["autoCompactionEnabled", "setAutoCompaction", false, true],
    ["steeringMode", "setSteeringMode", "all", "one-at-a-time"],
    ["followUpMode", "setFollowUpMode", "all", "one-at-a-time"],
  ] as const)(
    "does not let an old %s failure roll back a newer success",
    async (key, method, initial, next) => {
      const runtimeSettings: PiRuntimeSettings = {
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
      };
      const requests = [
        deferred<RouteResponse>(),
        deferred<RouteResponse>(),
        deferred<RouteResponse>(),
      ];
      let index = 0;
      installFetch((url, init) => {
        if (url.startsWith("/api/control/")) return requests[index++]!.promise;
        if (url.startsWith("/api/bootstrap"))
          return {
            body: bootstrapPayload({
              snapshot: activeSnapshot({
                runtimeSettings: { ...runtimeSettings },
              }),
            }),
          };
        if (url.startsWith("/api/snapshot"))
          return {
            body: activeSnapshot({ runtimeSettings: { ...runtimeSettings } }),
          };
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      const set = store[method] as (
        value: typeof initial | typeof next,
      ) => Promise<boolean>;
      const a = set(next);
      const b = set(initial);
      const c = set(next);
      Object.assign(runtimeSettings, { [key]: next });
      requests[1]!.resolve({ body: { ok: true } });
      requests[2]!.resolve({ body: { ok: true } });
      await Promise.all([b, c]);
      requests[0]!.resolve({ status: 400, body: { error: "old failure" } });
      expect(await a).toBe(false);
      expect(store.getState().runtimeSettings?.[key]).toBe(next);
    },
  );

  it("reconciles a failed latest setting instead of trusting an optimistic predecessor", async () => {
    const runtimeSettings: PiRuntimeSettings = {
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "all",
      followUpMode: "all",
    };
    const requests = [deferred<RouteResponse>(), deferred<RouteResponse>()];
    let index = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/")) return requests[index++]!.promise;
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({ runtimeSettings }),
          }),
        };
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ runtimeSettings }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const a = store.setAutoRetry(true);
    const b = store.setAutoRetry(false);
    requests[0]!.resolve({ status: 400, body: { error: "first failed" } });
    await a;
    requests[1]!.resolve({ status: 400, body: { error: "second failed" } });
    await b;
    await vi.waitFor(() =>
      expect(store.getState().runtimeSettings?.autoRetryEnabled).toBe(false),
    );
  });

  it("copies the complete Host response instead of the truncated or live preview", async () => {
    const fullText = `${"x".repeat(70_000)}THE_END_42\n`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let copyUrl = "";
    installFetch((url, init) => {
      if (url.startsWith("/api/transcript/assistant-text")) {
        copyUrl = url;
        return { body: { text: fullText } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        pageMessages: [
          {
            role: "assistant",
            content: `${fullText.slice(0, 64_000)}\n…[truncated]`,
          },
          {
            role: "assistant",
            content: "unfinished response",
            __inspireLiveId: "live-1",
            __inspireSettled: false,
          },
        ],
      }),
    });

    await expect(store.sendPrompt("/copy")).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(fullText));
    const query = new URL(copyUrl, "http://localhost").searchParams;
    expect(query.get("sessionId")).toBe("s1");
    expect(query.get("viewId")).toBe(store.getState().transcriptViewId);
  });

  it("does not write delayed copy content after a branch change", async () => {
    const response = deferred<RouteResponse>();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installFetch((url, init) =>
      url.startsWith("/api/transcript/assistant-text")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    await store.sendPrompt("/copy");
    const snapshot = activeSnapshot();
    snapshot.active!.transcriptPage.viewId = "another-branch";
    socket.emit({ type: "snapshot", data: snapshot });
    response.resolve({ body: { text: "old branch" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)?.status).toBe(
        "error",
      ),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("executes browser-native model and session information commands", async () => {
    const modelBodies: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/control/model")) {
        modelBodies.push(jsonBody(init));
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(
      store.sendPrompt("/model kimi-coding/kimi-k3"),
    ).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    await vi.waitFor(() => expect(modelBodies).toHaveLength(1));
    await store.sendPrompt("/session");

    expect(modelBodies[0]).toEqual({
      sessionId: "s1",
      provider: "kimi-coding",
      modelId: "kimi-k3",
    });
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "session",
      status: "info",
      details: expect.arrayContaining([
        expect.objectContaining({ label: "Project" }),
        expect.objectContaining({ label: "Model" }),
      ]),
    });
  });
});
