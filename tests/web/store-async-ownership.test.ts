// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("detail snapshots and selection intent", () => {
  it.each(["open", "new", "deselect"] as const)(
    "keeps a pending %s when the previous detail interest synchronizes",
    async (operation) => {
      const pending = deferred<RouteResponse>();
      installFetch((url, init) => {
        if (url === "/api/sessions/open") {
          return jsonBody(init).id === "s2"
            ? { body: activeSnapshot({ sessionId: "s2" }) }
            : pending.promise;
        }
        if (url === "/api/sessions/new" || url === "/api/sessions/deselect")
          return pending.promise;
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      await store.openSession("s2");
      expect(JSON.parse(socket.sent[0]!)).toEqual({
        type: "detail_interest",
        sessionId: "s2",
        revision: 1,
      });

      const selecting =
        operation === "open"
          ? store.openSession("s3")
          : operation === "new"
            ? store.newSession("/proj")
            : store.deselectSession();
      expect(store.getState().sessionSelectionPending).toBe(true);
      socket.emit({
        type: "snapshot",
        detailSessionId: "s2",
        detailRevision: 1,
        data: activeSnapshot({
          sessionId: "s2",
          sessionName: "Refreshed B",
        }),
      });
      // Apply the detail, but keep the newer HTTP selection's owner.
      expect(store.getState()).toMatchObject({
        sessionId: "s2",
        sessionName: "Refreshed B",
        sessionSelectionPending: true,
        openingSessionId: operation === "open" ? "s3" : null,
      });

      pending.resolve({
        body:
          operation === "deselect"
            ? { active: null, runState: "idle", sessionStatuses: {} }
            : activeSnapshot({ sessionId: "s3" }),
      });
      await selecting;
      const sessionId = operation === "deselect" ? null : "s3";
      expect(store.getState()).toMatchObject({
        sessionId,
        sessionSelectionPending: false,
        openingSessionId: null,
      });
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        type: "detail_interest",
        sessionId,
        revision: 2,
      });
    },
  );

  it("still retires a pending selection when bootstrap replaces the API", async () => {
    const pending = deferred<RouteResponse>();
    installFetch((url, init) =>
      url === "/api/sessions/open" ? pending.promise : baseRoutes(url, init),
    );
    const { store } = await initStore();
    const selecting = store.openSession("s2");
    await store.init(null);
    pending.resolve({ body: activeSnapshot({ sessionId: "s2" }) });
    await selecting;
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      sessionSelectionPending: false,
      openingSessionId: null,
    });
  });
});

describe("resync failure ownership", () => {
  it.each([
    ["s2", null],
    ["s2", "Current operation failed"],
    ["s1", "Current operation failed"],
  ] as const)(
    "keeps %s's current error (%s) after an older selection's read fails",
    async (target, currentError) => {
      const pending = deferred<RouteResponse>();
      const fetch = installFetch((url, init) => {
        if (url.startsWith("/api/snapshot")) return pending.promise;
        if (url === "/api/sessions/open")
          return {
            body: activeSnapshot({ sessionId: String(jsonBody(init).id) }),
          };
        if (url === "/api/control/abort")
          return { status: 503, body: { error: currentError } };
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      socket.emit({ type: "runtime_ready", sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/snapshot"),
        ),
      ).toHaveLength(1);

      await store.openSession("s2");
      if (target === "s1") await store.openSession("s1");
      if (currentError) await store.abort();
      expect(store.getState().error).toBe(currentError);
      pending.resolve({
        status: 503,
        body: { error: "Old snapshot unavailable" },
      });
      // Drain the rejected response and its catch before checking absence.
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({
        sessionId: target,
        error: currentError,
        errorSeverity: "error",
      });
    },
  );

  it("ignores a failure after a same-session branch-view replacement", async () => {
    const pending = deferred<RouteResponse>();
    installFetch((url, init) =>
      url.startsWith("/api/snapshot") ? pending.promise : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    socket.emit({ type: "runtime_ready", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit({
      type: "snapshot",
      detailSessionId: "s1",
      detailRevision: 0,
      data: activeSnapshot({ transcriptPage: { viewId: "replacement-view" } }),
    });
    pending.resolve({ status: 503, body: { error: "Old view unavailable" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      transcriptViewId: "replacement-view",
      error: null,
    });
  });

  it("still reports a failed read of the current selection", async () => {
    installFetch((url, init) =>
      url.startsWith("/api/snapshot")
        ? { status: 503, body: { error: "Snapshot unavailable" } }
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    socket.emit({ type: "runtime_ready", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      error: "Failed to refresh session: Snapshot unavailable",
      errorSeverity: "warning",
    });
  });

  it("keeps a same-API 401 transport-wide after navigation", async () => {
    const pending = deferred<RouteResponse>();
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) return pending.promise;
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "s2" }) };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({ type: "runtime_ready", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
    await store.openSession("s2");
    pending.resolve({ status: 401, body: { error: "Pairing expired" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      needsToken: true,
      connection: "offline",
      error: null,
    });
  });
});
