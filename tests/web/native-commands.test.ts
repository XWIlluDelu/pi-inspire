// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeSettings } from "../../shared/contracts";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  selectSession,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("Pi native command dispatch", () => {
  beforeEach(() => installFakeWebSocket());

  it("keeps Compact's pending receipt while handling unknown and terminal-only input locally", async () => {
    const native = deferred<RouteResponse>();
    const calls = installFetch((url, init) =>
      url === "/api/control/native-command"
        ? native.promise
        : baseRoutes(url, init),
    );
    const { store } = await initStore();
    const latest = () => store.getState().commandActivities.s1?.at(-1);
    await expect(store.sendPrompt("/does-not-exist")).resolves.toBe(false);
    expect(latest()).toMatchObject({
      command: "does-not-exist",
      status: "error",
    });
    await expect(
      store.sendPrompt("/bug unexpected response"),
    ).resolves.toMatchObject({ accepted: true });
    expect(latest()).toMatchObject({
      command: "bug",
      status: "warning",
      action: { kind: "open-terminal", value: "/bug unexpected response" },
    });
    expect(
      calls.mock.calls.filter(
        ([url]) =>
          url === "/api/prompt" || url === "/api/control/native-command",
      ),
    ).toEqual([]);

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
    expect(latest()).toMatchObject({ command: "session" });
    expect(store.getState().commandActivities.s1).toContainEqual(
      expect.objectContaining({ command: "compact", status: "running" }),
    );

    native.resolve({
      body: {
        command: "compact",
        outcome: "completed",
        message: "Context compacted.",
      },
    });
    await vi.waitFor(() =>
      expect(store.getState().live.notices.at(-1)).toMatchObject({
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

  it("gates Compact during active work and reports an unknown Export without retrying", async () => {
    const settings = activeSnapshot();

    settings.sessionStatuses.s1 = { runState: "running" };
    const calls = installFetch((url, init) => {
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
    socket.emitSnapshot(settings);
    const native = () =>
      calls.mock.calls.filter(([url]) => url === "/api/control/native-command");

    await store.sendPrompt("/compact");
    expect(native()).toEqual([]);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "compact",
      status: "warning",
      message: expect.stringContaining("Wait for the current Pi operation"),
    });

    await store.sendPrompt("/export");
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

  it.each([true, false])(
    "retains the latest confirmed runtime setting (%s)",
    async (accepted) => {
      const settings: PiRuntimeSettings = {
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
      };
      const old = deferred<RouteResponse>();
      const latest = deferred<RouteResponse>();
      const send = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
      installFetch((url, init) => {
        if (url === "/api/control/runtime-setting") return send(jsonBody(init));
        if (url.startsWith("/api/snapshot"))
          return { body: activeSnapshot({ runtimeSettings: settings }) };
        return baseRoutes(url, init);
      });
      const { store } = await initStore(
        activeSnapshot({ runtimeSettings: settings }),
      );
      const change = (value: boolean) =>
        store.setPiRuntimeSetting({ key: "autoRetryEnabled", value });
      const first = change(!accepted);
      const second = change(accepted);
      expect(store.getState().runtimeSettings?.autoRetryEnabled).toBe(false);
      expect(store.getState().pendingRuntimeSettings.autoRetryEnabled).toBe(
        accepted,
      );
      expect(send.mock.calls).toEqual(
        [!accepted, accepted].map((value) => [
          { sessionId: "s1", setting: { key: "autoRetryEnabled", value } },
        ]),
      );
      settings.autoRetryEnabled = accepted;
      const refusal = { status: 400, body: { error: "Pi refused" } };
      latest.resolve(accepted ? { body: { ok: true } } : refusal);
      expect(await second).toBe(accepted);
      old.resolve(refusal);
      expect(await first).toBe(false);
      await vi.waitFor(() =>
        expect(store.getState().runtimeSettings?.autoRetryEnabled).toBe(
          accepted,
        ),
      );
    },
  );

  it("keeps a delayed command failure in its original session without notifying the new one", async () => {
    const response = deferred<RouteResponse>();
    installFetch((url, init) =>
      url.startsWith("/api/control/model")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store } = await initStore();
    await store.sendPrompt("/model kimi-coding/kimi-k3");
    await selectSession(store, activeSnapshot({ sessionId: "s2" }));
    const notices = store.getState().live.notices.length;
    response.resolve({ status: 400, body: { error: "Provider denied model" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "model",
        status: "error",
        message: "Provider denied model",
      }),
    );
    expect(store.getState().live.notices).toHaveLength(notices);
  });

  it("replaces a session's query readouts in place and clears only queries on departure", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    const readouts = () => store.getState().commandActivities.s1;
    await store.sendPrompt("/unknown-query-test");
    await store.sendPrompt("/session");

    const showStats = async (stats: unknown) => {
      socket.emitSnapshot(
        activeSnapshot({
          stats,
          sessionFile: "/sessions/retained.jsonl",
        }),
      );
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
    ]);
    socket.emit({ type: "agent_start", sessionId: "s1" });
    expect(store.getState().commandActivities.s1).toHaveLength(2);
    await selectSession(store, activeSnapshot({ sessionId: "s2" }));
    expect(
      store.getState().commandActivities.s1?.map((item) => item.command),
    ).toEqual(["unknown-query-test"]);
    expect(store.getState().commandActivities.s2).toBeUndefined();
    await selectSession(store, activeSnapshot());
    expect(
      store.getState().commandActivities.s1?.map((item) => item.command),
    ).toEqual(["unknown-query-test"]);
  });
});
