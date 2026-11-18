import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HTTP_OBSERVATION_TIMEOUT_MS } from "../../src/api";
import {
  activeSnapshot,
  deferred,
  emptySnapshot,
  FakeWebSocket,
  inputReceipt,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  selectSession,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const denied = { status: 401, body: { error: "Pairing expired" } };
const unavailable = { status: 503, body: { error: "Read unavailable" } };
const openResponse = (init: RequestInit, thinkingLevel = "medium") => ({
  body: activeSnapshot({ sessionId: String(jsonBody(init).id), thinkingLevel }),
});
const ready = (socket: FakeWebSocket, sessionId = "s1") =>
  socket.emit({ type: "runtime_ready", sessionId });

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("does not finish or report failure for a replacement export when an old download returns", async () => {
  const retired = deferred<RouteResponse>();
  const replacement = deferred<RouteResponse>();
  const started = deferred<void>();
  installStoreRoutes((url, init) => {
    if (url === "/api/sessions/export")
      return jsonBody(init).format === "html"
        ? { body: { downloadId: "old", fileName: "history.html" } }
        : replacement.promise;
    if (url === "/api/sessions/s1/exports/old") {
      started.resolve();
      return retired.promise;
    }
  });
  const { store } = await initStore();
  const old = expect(store.exportSession("s1", "html")).rejects.toThrow(
    "Host connection changed",
  );
  await started.promise;
  await store.init();
  const current = expect(store.exportSession("s1", "jsonl")).rejects.toThrow(
    "Export storage unavailable",
  );
  retired.resolve({ body: "old history" });
  await old;
  expect(store.getState()).toMatchObject({
    exportingSessions: { s1: { format: "jsonl" } },
    live: { notices: [] },
  });
  replacement.resolve({
    status: 503,
    body: { error: "Export storage unavailable" },
  });
  await current;
  expect(store.getState().exportingSessions).toEqual({});
  expect(store.getState().live.notices.at(-1)).toMatchObject({
    kind: "error",
    text: "Export storage unavailable",
  });
});

it.each(["deadline", "selection", "bootstrap"] as const)(
  "retires a pending open on %s without letting its reply change current authorization",
  async (reason) => {
    const pending = deferred<RouteResponse>();
    const open = vi
      .fn<(init: RequestInit) => RouteResponse | Promise<RouteResponse>>(
        openResponse,
      )
      .mockReturnValueOnce(pending.promise);
    installStoreRoutes((url, init) =>
      url === "/api/sessions/open"
        ? jsonBody(init).id === "expired"
          ? denied
          : open(init)
        : undefined,
    );
    const { store, socket } = await initStore();
    const first = store.openSession("s2");
    const signal = open.mock.calls[0]?.[0].signal;
    const current =
      reason === "deadline" ? "s2" : reason === "selection" ? "s3" : "s1";
    if (reason === "bootstrap") {
      socket.close();
      expect(signal?.aborted).toBe(false);
      await store.init();
    } else {
      if (reason === "deadline") {
        await store.openSession("s2");
        expect(open).toHaveBeenCalledOnce();
        await tick(30_000);
        socket.emit({ type: "heartbeat" });
        await tick(HTTP_OBSERVATION_TIMEOUT_MS - 30_000);
        await first;
        expect(store.getState()).toMatchObject({
          sessionId: "s1",
          connection: "open",
          sessionSelectionPending: false,
          sessionActionError: expect.stringContaining("could not confirm"),
        });
      }
      await store.openSession(current);
      expect(open).toHaveBeenCalledTimes(2);
    }
    await first;
    expect(signal?.aborted).toBe(true);
    pending.resolve(
      reason === "deadline"
        ? { body: activeSnapshot({ sessionId: "stale" }) }
        : denied,
    );
    await tick();
    expect(store.getState()).toMatchObject({
      sessionId: current,
      needsToken: false,
      sessionSelectionPending: false,
    });
    if (reason === "selection") {
      await store.openSession("expired");
      expect(store.getState()).toMatchObject({
        needsToken: true,
        sessionSelectionPending: false,
      });
    }
  },
);

it("requires a workspace and asks for confirmation only before repeating a possibly accepted creation", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const timeout = deferred<RouteResponse>();
  const superseded = deferred<RouteResponse>();
  const create = vi
    .fn<() => RouteResponse | Promise<RouteResponse>>()
    .mockReturnValueOnce({ status: 400, body: { error: "Invalid directory" } })
    .mockReturnValueOnce(timeout.promise)
    .mockReturnValueOnce({ body: activeSnapshot({ sessionId: "created" }) })
    .mockReturnValueOnce(superseded.promise);
  installStoreRoutes((url, init) => {
    if (url === "/api/sessions/new") return create();
    if (url === "/api/sessions/deselect") return { body: emptySnapshot };
    if (url === "/api/sessions/open") return openResponse(init);
  });
  const { store } = await initStore();
  await store.deselectSession();
  await expect(store.newSession()).resolves.toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(store.getState().live.notices.at(-1)?.text).toBe(
    "Enter a project directory to start a session",
  );
  await expect(store.newSession("/invalid")).resolves.toBeNull();
  const creating = store.newSession("/proj");
  await store.newSession("/proj");
  expect(create).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  timeout.resolve({ status: 504, body: { error: "Gateway timed out" } });
  await expect(creating).resolves.toBeNull();
  await store.init();
  await store.newSession("/proj");
  expect(create).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining("may still complete"),
  );
  confirm.mockReturnValue(true);
  await expect(store.newSession("/proj")).resolves.toBe("created");

  confirm.mockClear().mockReturnValue(false);
  const interrupted = store.newSession("/proj");
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(4));
  await store.openSession("other");
  await expect(interrupted).resolves.toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  await store.newSession("/proj");
  expect(create).toHaveBeenCalledTimes(4);
  expect(confirm).toHaveBeenCalledOnce();
});

it.each(["create", "deselect", "switch", "clear"] as const)(
  "keeps explicit selection ownership across %s and an addressed update",
  async (gesture) => {
    const retired = deferred<RouteResponse>();
    const selection = deferred<RouteResponse>();
    const open = vi.fn(() => selection.promise);
    let retiredSignal: RequestInit["signal"];
    installStoreRoutes((url, init) => {
      if (url === "/api/sessions/open") return open();
      if (gesture === "clear" && url === "/api/sessions/deselect")
        return selection.promise;
      if (url === "/api/sessions/new" || url === "/api/sessions/deselect") {
        retiredSignal = init.signal;
        return retired.promise;
      }
    });
    const { store, socket } = await initStore();
    await store.openSession("s1");
    expect(open).not.toHaveBeenCalled();
    const target =
      gesture === "clear" ? null : gesture === "switch" ? "s2" : "s1";
    const previous =
      gesture === "create"
        ? store.newSession("/proj")
        : gesture === "deselect"
          ? store.deselectSession()
          : undefined;
    const latest = target ? store.openSession(target) : store.deselectSession();
    if (previous) {
      await previous;
      expect(retiredSignal?.aborted).toBe(true);
      retired.resolve({
        body:
          gesture === "create"
            ? activeSnapshot({ sessionId: "stale" })
            : emptySnapshot,
      });
      await tick();
    }
    socket.emitSnapshot(activeSnapshot({ sessionName: "Refreshed A" }));
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      sessionName: "Refreshed A",
      sessionSelectionPending: true,
      openingSessionId: target,
    });
    selection.resolve({
      body: target
        ? activeSnapshot({ sessionId: target, sessionName: "Selected" })
        : emptySnapshot,
    });
    await latest;
    expect(open).toHaveBeenCalledTimes(target ? 1 : 0);
    expect(store.getState()).toMatchObject({
      sessionId: target,
      ...(target ? { sessionName: "Selected" } : {}),
      sessionSelectionPending: false,
      openingSessionId: null,
    });
    if (target !== "s1")
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        type: "detail_interest",
        sessionId: target,
        revision: 1,
      });
  },
);

it("keeps a fresh projection after delayed Stop and Compact on a new view", async () => {
  const command = deferred<RouteResponse>();
  const stop = deferred<RouteResponse>();
  const sent = deferred<Record<string, unknown>>();
  const snapshot = deferred<RouteResponse>();
  const read = vi.fn(() => snapshot.promise);
  installStoreRoutes((url, init) => {
    if (url === "/api/control/native-command") return command.promise;
    if (url === "/api/control/abort") {
      sent.resolve(jsonBody(init));
      return stop.promise;
    }
    if (url.startsWith("/api/snapshot")) return read();
    if (url === "/api/sessions/open") return openResponse(init);
  });
  const { store, socket } = await initStore();
  await store.sendPrompt("/compact");
  const stopping = store.abort();
  const stopRequest = await sent.promise;
  expect(stopRequest).toMatchObject({
    sessionId: "s1",
    expectedViewId: "view-s1",
  });
  socket.emitSnapshot(
    activeSnapshot({ transcriptPage: { viewId: "next-view" } }),
  );
  const viewId = store.getState().view.viewId!;
  ready(socket);
  await tick();
  expect(read).toHaveBeenCalledOnce();
  stop.resolve({
    status: 409,
    body: {
      ...inputReceipt("abort", stopRequest),
      state: "rejected",
      error: { status: 409, message: "Old abort failed" },
    },
  });
  await stopping;
  expect(store.getState().live.notices).toEqual([]);
  const message = "Context compacted.";
  command.resolve({
    body: { command: "compact", outcome: "completed", message },
  });
  await tick();
  snapshot.resolve({
    body: activeSnapshot({
      sessionName: "Fresh session",
      transcriptPage: { viewId },
    }),
  });
  await tick();
  expect(store.getState()).toMatchObject({
    sessionName: "Fresh session",
    error: null,
    view: { viewId },
  });
  expect(read).toHaveBeenCalledOnce();
  expect(store.getState().commandActivities.s1).toBeUndefined();
  expect(store.getState().live.notices.at(-1)?.text).toBe(message);
});

it.each([false, true])(
  "keeps the replacement projection when an old resync settles (auth expired: %s)",
  async (expired) => {
    const old = deferred<RouteResponse>();
    installStoreRoutes((url, init) => {
      if (url.startsWith("/api/snapshot")) return old.promise;
      if (url === "/api/sessions/open") return openResponse(init);
    });
    const { store, socket } = await initStore();
    ready(socket);
    await tick();

    const sessionId = expired ? "s2" : "s1";
    const viewId = expired ? "view-s2" : "replacement-view";
    const error = expired ? null : "Current projection failed";
    const current = activeSnapshot({
      sessionId,
      pageMessages: [{ role: "assistant", content: "current" }],
      transcriptPage: { viewId },
      ...(error ? { projectionHealth: { status: "error", message: error } } : {}),
    });
    if (expired) await selectSession(store, current);
    else {
      await store.openSession("s2");
      await store.openSession("s1");
      socket.emitSnapshot(current);
    }
    old.resolve(expired ? denied : unavailable);
    await tick();
    expect(store.getState()).toMatchObject({
      sessionId,
      view: { viewId },
      error,
      live: { messages: [{ content: "current" }] },
      needsToken: expired,
    });
  },
);
