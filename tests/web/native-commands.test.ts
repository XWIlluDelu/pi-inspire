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

describe("Pi native command dispatch", () => {
  beforeEach(() => installFakeWebSocket());

  it("keeps unsupported slash input and /bug out of prompt delivery", async () => {
    let dispatchCount = 0;
    installFetch((url, init) => {
      if (
        url.startsWith("/api/prompt") ||
        url.startsWith("/api/control/native-command")
      )
        dispatchCount += 1;
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await expect(store.sendPrompt("/does-not-exist")).resolves.toBe(false);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "does-not-exist",
      status: "error",
    });
    await expect(
      store.sendPrompt("/bug unexpected response"),
    ).resolves.toMatchObject({ accepted: true });
    expect(dispatchCount).toBe(0);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "bug",
      status: "warning",
      action: {
        kind: "open-terminal",
        value: "/bug unexpected response",
      },
    });
  });

  it("does not evict an in-flight Host receipt from bounded command history", async () => {
    const native = deferred<RouteResponse>();
    const calls = installFetch((url, init) =>
      url === "/api/control/native-command"
        ? native.promise
        : baseRoutes(url, init),
    );
    const { store } = await initStore();

    await expect(
      store.sendPrompt("/compact focus on decisions"),
    ).resolves.toMatchObject({
      accepted: true,
    });
    expect(calls.mock.calls.filter(([url]) => url === "/api/prompt")).toEqual(
      [],
    );
    const [, request] = calls.mock.calls.find(
      ([url]) => url === "/api/control/native-command",
    )!;
    expect(jsonBody(request!)).toEqual({
      sessionId: "s1",
      command: "compact",
      argument: "focus on decisions",
    });
    await store.sendPrompt("/session");
    await store.sendPrompt("/hotkeys");
    await store.sendPrompt("/quit");
    await store.sendPrompt("/share");

    expect(store.getState().commandActivities.s1).toHaveLength(4);
    expect(store.getState().commandActivities.s1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "compact", status: "running" }),
        expect.objectContaining({
          command: "share",
          status: "warning",
          details: [{ label: "Run in Pi", value: "/share" }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: "/share",
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
      expect(store.getState().notices.at(-1)).toMatchObject({
        kind: "info",
        text: "Context compacted.",
      }),
    );
    expect(
      store
        .getState()
        .commandActivities.s1?.some(({ command }) => command === "compact"),
    ).toBe(false);
  });

  it("opens the model picker from both surfaces before discovery, reserving native names", async () => {
    const prompts: unknown[] = [];
    const calls = installFetch((url, init) => {
      if (url === "/api/prompt") {
        prompts.push(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        availableModels: [],
        commands: [
          { name: "model", source: "extension" },
          { name: "plugin:model", source: "extension" },
        ],
      }),
    });
    for (const run of [store.sendPrompt, store.runPaletteNativeCommand]) {
      const previous = store.getState().nativeCommandUiRequest?.id;
      await run("/model");
      expect(store.getState().nativeCommandUiRequest).toMatchObject({
        action: "model",
      });
      expect(store.getState().nativeCommandUiRequest?.id).not.toBe(previous);
    }
    await store.sendPrompt("/model\tmissing");
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "model",
      status: "warning",
    });
    expect(prompts).toEqual([]);
    await store.sendPrompt("/plugin:model\tcustom");
    expect(prompts).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        message: "/plugin:model custom",
      }),
    ]);
    expect(
      calls.mock.calls.some(([url]) => url === "/api/control/native-command"),
    ).toBe(false);
  });

  it("gates Compact during active work and reports an unknown Export without retrying", async () => {
    const settings = activeSnapshot();
    settings.runState = "running";
    settings.sessionStatuses.s1 = { runState: "running" };
    const calls = installFetch((url, init) => {
      const selection = {
        model: settings.active!.model,
        thinkingLevel: "low",
      };
      if (url === "/api/control/model" || url === "/api/control/thinking")
        return { body: selection };
      if (url === "/api/control/native-command")
        return {
          status: 504,
          body: {
            error: "Pi export outcome is unknown",
            code: "PI_RPC_OUTCOME_UNKNOWN",
          },
        };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({ type: "snapshot", data: settings });
    const native = () =>
      calls.mock.calls.filter(([url]) => url === "/api/control/native-command");

    await store.sendPrompt("/compact");
    expect(native()).toEqual([]);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "compact",
      status: "warning",
      message: expect.stringContaining("Wait for the current Pi operation"),
    });

    await store.sendPrompt("/model kimi-coding/kimi-k3");
    await store.sendPrompt("/thinking low");
    await store.sendPrompt("/export");
    expect(calls.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining(["/api/control/model", "/api/control/thinking"]),
    );
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "export",
        status: "warning",
        message: expect.stringMatching(/check the session before trying again/),
      }),
    );
    expect(native().map(([, init]) => jsonBody(init!))).toEqual([
      { sessionId: "s1", command: "export" },
    ]);
  });

  describe("runtime setting writes", () => {
    function installSettingRoutes(
      settings: PiRuntimeSettings,
      mutate: (
        url: string,
        body: Record<string, unknown>,
      ) => RouteResponse | Promise<RouteResponse>,
    ) {
      return installFetch((url, init) => {
        if (url.startsWith("/api/control/")) return mutate(url, jsonBody(init));
        const snapshot = activeSnapshot({ runtimeSettings: settings });
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot }) };
        if (url.startsWith("/api/snapshot")) return { body: snapshot };
        return baseRoutes(url, init);
      });
    }

    it("dispatches each setting to its addressed Pi endpoint", async () => {
      const settings: PiRuntimeSettings = {
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
      };
      const mutate = vi.fn(() => ({ body: { ok: true } }));
      installSettingRoutes(settings, mutate);
      const { store } = await initStore();

      await store.setAutoCompaction(false);
      await store.setAutoRetry(false);
      await store.setSteeringMode("one-at-a-time");
      await store.setFollowUpMode("all");

      expect(mutate.mock.calls).toEqual([
        ["/api/control/auto-compaction", { sessionId: "s1", enabled: false }],
        ["/api/control/auto-retry", { sessionId: "s1", enabled: false }],
        [
          "/api/control/steering-mode",
          { sessionId: "s1", mode: "one-at-a-time" },
        ],
        ["/api/control/follow-up-mode", { sessionId: "s1", mode: "all" }],
      ]);
    });

    it.each([false, true])(
      "reconciles overlapping changes when the latest write is accepted: %s",
      async (accepted) => {
        const settings: PiRuntimeSettings = {
          autoCompactionEnabled: false,
          autoRetryEnabled: false,
          steeringMode: "all",
          followUpMode: "all",
        };
        const old = deferred<RouteResponse>();
        const latest = deferred<RouteResponse>();
        installSettingRoutes(
          settings,
          vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockReturnValueOnce(latest.promise),
        );
        const { store } = await initStore();
        const olderWrite = store.setAutoRetry(true);
        const latestWrite = store.setAutoRetry(accepted);
        if (accepted) {
          settings.autoRetryEnabled = true;
          latest.resolve({ body: { ok: true } });
          expect(await latestWrite).toBe(true);
          old.resolve({ status: 400, body: { error: "old failure" } });
          expect(await olderWrite).toBe(false);
        } else {
          old.resolve({ status: 400, body: { error: "old failure" } });
          expect(await olderWrite).toBe(false);
          latest.resolve({ status: 400, body: { error: "latest failure" } });
          expect(await latestWrite).toBe(false);
        }
        await vi.waitFor(() =>
          expect(store.getState().runtimeSettings?.autoRetryEnabled).toBe(
            accepted,
          ),
        );
      },
    );
  });

  it("retires an in-flight /copy when its branch changes", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const response = deferred<RouteResponse>();
    const fetch = installFetch((url, init) =>
      url.startsWith("/api/transcript/assistant-text")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: {
        ...activeSnapshot({
          pageMessages: [
            {
              role: "assistant",
              content: "settled response",
            },
            {
              role: "assistant",
              content: "unfinished response",
              __inspireLiveId: "live-1",
              __inspireSettled: false,
            },
          ],
        }),
        runState: "running",
      },
    });

    await expect(store.sendPrompt("/copy")).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/transcript/assistant-text?"),
        expect.anything(),
      ),
    );
    const request = fetch.mock.calls.find(([url]) =>
      String(url).startsWith("/api/transcript/assistant-text?"),
    );
    const query = new URL(String(request![0]), "http://localhost").searchParams;
    expect(query.get("sessionId")).toBe("s1");
    expect(query.get("viewId")).toBe(store.getState().transcriptViewId);
    const snapshot = activeSnapshot();
    snapshot.active!.transcriptPage.viewId = "another-branch";
    socket.emit({ type: "snapshot", data: snapshot });
    response.resolve({ body: { text: "old branch" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)?.status).toBe(
        "warning",
      ),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears the successful rename receipt and retains a refusal as a command result", async () => {
    const rename = vi
      .fn()
      .mockReturnValueOnce({ body: { ok: true } })
      .mockReturnValueOnce({
        status: 400,
        body: { error: "Pi rejected the name" },
      });
    installFetch((url, init) =>
      url === "/api/sessions/rename" ? rename() : baseRoutes(url, init),
    );
    const { store } = await initStore();
    const latest = () => store.getState().commandActivities.s1?.at(-1);
    await store.sendPrompt("/name New session");
    await vi.waitFor(() =>
      expect(store.getState().notices.at(-1)?.kind).toBe("info"),
    );
    expect(latest()).toBeUndefined();

    await store.sendPrompt("/name Refused title");
    await vi.waitFor(() =>
      expect(latest()).toMatchObject({
        command: "name",
        status: "error",
        message: "Pi rejected the name",
      }),
    );
  });

  it("keeps a delayed command failure in its original session without notifying the new one", async () => {
    const response = deferred<RouteResponse>();
    installFetch((url, init) =>
      url.startsWith("/api/control/model")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    await store.sendPrompt("/model kimi-coding/kimi-k3");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    const notices = store.getState().notices.length;
    response.resolve({ status: 400, body: { error: "Provider denied model" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "model",
        status: "error",
        message: "Provider denied model",
      }),
    );
    expect(store.getState().notices).toHaveLength(notices);
  });

  it("replaces a session's query readouts in place and clears only queries on departure", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    const readouts = () => store.getState().commandActivities.s1;
    await store.sendPrompt("/unknown-query-test");
    await store.sendPrompt("/session");
    await store.sendPrompt("/name");
    await store.sendPrompt("/quit");

    const showStats = async (stats: unknown) => {
      socket.emit({
        type: "snapshot",
        data: activeSnapshot({
          stats,
          sessionFile: "/sessions/retained.jsonl",
        }),
      });
      await store.sendPrompt("/session");
      return Object.fromEntries(
        readouts()![1]!.details!.map(({ id, value }) => [id, value]),
      );
    };
    expect(
      await showStats({
        totalMessages: 0,
        tokens: { total: 0 },
        cost: 0,
        contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 },
      }),
    ).toEqual({
      messages: "0",
      tokens: "0",
      cost: "$0.00",
      context: "0 / 1,000 (0%)",
    });
    expect(await showStats({})).toEqual({});
    expect(readouts()?.map(({ command }) => command)).toEqual([
      "unknown-query-test",
      "session",
      "name",
      "quit",
    ]);
    socket.emit({ type: "agent_start", sessionId: "s1" });
    expect(store.getState().commandActivities.s1).toHaveLength(4);
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    expect(
      store.getState().commandActivities.s1?.map((item) => item.command),
    ).toEqual(["unknown-query-test"]);
    expect(store.getState().commandActivities.s2).toBeUndefined();
    socket.emit({ type: "snapshot", data: activeSnapshot() });
    expect(
      store.getState().commandActivities.s1?.map((item) => item.command),
    ).toEqual(["unknown-query-test"]);
  });
});
