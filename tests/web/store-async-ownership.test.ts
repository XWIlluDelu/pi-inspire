import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HTTP_OBSERVATION_TIMEOUT_MS } from "../../src/api";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  emptySnapshot,
  FakeWebSocket,
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

it("keeps native Export and History Edit pending until Pi completes and observes each exactly once", async () => {
  const exported = deferred<RouteResponse>();
  const navigated = deferred<RouteResponse>();
  const native = "/api/control/native-command";
  const branch = "/api/branches/navigate";
  const fetch = installStoreRoutes((url) => {
    if (url === native) return exported.promise;
    if (url === branch) return navigated.promise;
  });
  const { store, socket } = await initStore();
  await store.sendPrompt("/export");
  const opening = store.navigateBranch("u1", "edit");
  for (let elapsed = 0; elapsed < 300_000; elapsed += 30_000) {
    await tick(30_000);
    socket.emit({ type: "heartbeat" });
  }
  expect(store.getState()).toMatchObject({
    connection: "open",
    branchActionId: "edit:u1",
    branchTreeError: null,
    commandActivities: { s1: [{ status: "running" }] },
  });
  exported.resolve({
    body: {
      command: "export",
      outcome: "completed",
      message: "Pi completed",
      details: [{ label: "Path", value: "/tmp/export.html" }],
    },
  });
  navigated.resolve({
    body: {
      snapshot: activeSnapshot({
        transcriptPage: { viewId: "navigated-view" },
      }),
      editorText: "Returned editor text",
    },
  });
  await expect(opening).resolves.toBe(true);
  await tick();
  expect(store.getState()).toMatchObject({
    branchActionId: null,
    view: { viewId: "navigated-view" },
    commandActivities: {
      s1: [
        {
          status: "success",
          action: { kind: "copy", value: "/tmp/export.html" },
        },
      ],
    },
  });
  expect(store.drafts.get("s1").text).toBe("Returned editor text");
  expect(
    fetch.mock.calls
      .map(([url]) => url)
      .filter((url) => url === native || url === branch),
  ).toEqual([native, branch]);
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

it.each(["resync", "new", "deselect"] as const)(
  "keeps a %s committed while replacement bootstrap was in flight",
  async (change) => {
    const pending = deferred<RouteResponse>();
    let reconnecting = false;
    const model = { provider: "provider", id: "new-model" };
    installStoreRoutes((url, init) => {
      if (reconnecting && url.startsWith("/api/bootstrap"))
        return pending.promise;
      if (url === "/api/sessions/new")
        return { body: activeSnapshot({ sessionId: "s2" }) };
      if (url === "/api/sessions/deselect") return { body: emptySnapshot };
      if (url === "/api/control/model")
        return { body: { model, thinkingLevel: "medium" } };
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ model }) };
      if (url === "/api/preferences") return { body: jsonBody(init) };
    });
    const { store } = await initStore();
    reconnecting = true;
    const starting = store.init();
    if (change === "new") await store.newSession("/proj");
    if (change === "deselect") await store.deselectSession();
    if (change === "resync") await store.setModel(model.provider, model.id);
    const id = change === "deselect" ? null : change === "new" ? "s2" : "s1";
    expect(store.getState().sessionId).toBe(id);
    pending.resolve({ body: bootstrapPayload({ startupSessionId: "s1" }) });
    await starting;
    expect(store.getState().sessionId).toBe(id);
    if (change === "resync")
      expect(store.getState().model).toMatchObject(model);
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(
      new URL(socket.url, window.location.href).searchParams.get("detail"),
    ).toBe(id ?? "");
  },
);

it.each(["return to session", "new view"] as const)(
  "keeps a fresh projection after delayed Stop and Compact across %s",
  async (change) => {
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
    expect(await sent.promise).toMatchObject({
      sessionId: "s1",
      expectedViewId: "view-s1",
    });
    if (change === "return to session") {
      await store.openSession("s2");
      await store.openSession("s1");
    } else
      socket.emitSnapshot(
        activeSnapshot({ transcriptPage: { viewId: "next-view" } }),
      );
    const viewId = store.getState().view.viewId!;
    ready(socket);
    await tick();
    expect(read).toHaveBeenCalledOnce();
    stop.resolve({ status: 409, body: { error: "Old abort failed" } });
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
  },
);

it.each([
  ["thinking", false],
  ["model", false],
  ["model", true],
] as const)(
  "fences delayed %s settings while the new selection refreshes (accepted: %s)",
  async (control, accepted) => {
    const mutation = deferred<RouteResponse>();
    const current = deferred<RouteResponse>();
    const model = { provider: "provider", id: "model" };
    const read = vi.fn(() => current.promise);
    installStoreRoutes((url, init) => {
      if (url === `/api/control/${control}`) return mutation.promise;
      if (url.startsWith("/api/snapshot")) return read();
      if (url === "/api/sessions/open") return openResponse(init, "low");
      if (url === "/api/preferences") return { body: jsonBody(init) };
    });
    const { store, socket } = await initStore();
    const changing =
      control === "thinking"
        ? store.setThinkingLevel("high")
        : store.setModel(model.provider, model.id);
    await store.openSession("s2");
    if (!accepted) await store.openSession("s1");
    const sessionId = store.getState().sessionId!;
    ready(socket, sessionId);
    await tick();
    expect(read).toHaveBeenCalledOnce();
    mutation.resolve(
      accepted ? { body: { model, thinkingLevel: "medium" } } : unavailable,
    );
    await changing;
    expect(store.getState()).toMatchObject({
      thinkingLevel: "low",
      live: { notices: [] },
    });
    current.resolve({
      body: activeSnapshot({ sessionId, sessionName: "Fresh session" }),
    });
    await tick();
    expect(store.getState().sessionName).toBe("Fresh session");
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each([
  "return to session",
  "new view",
  "new selection",
  "current authority 401",
] as const)(
  "keeps projection diagnostics after a stale resync across %s",
  async (change) => {
    const old = deferred<RouteResponse>();
    const read = vi.fn(() => old.promise);
    installStoreRoutes((url, init) => {
      if (url.startsWith("/api/snapshot")) return read();
      if (url === "/api/sessions/open") return openResponse(init);
    });
    const { store, socket } = await initStore();
    ready(socket);
    await tick();
    expect(read).toHaveBeenCalledOnce();

    const sameSession = change === "return to session" || change === "new view";
    const sessionId = sameSession ? "s1" : "s2";
    const viewId =
      change === "new view" ? "replacement-view" : `view-${sessionId}`;
    const error = sameSession ? "Current projection failed" : null;
    const current = activeSnapshot({
      sessionId,
      pageMessages: [{ role: "assistant", content: "current" }],
      transcriptPage: { viewId },
      ...(error
        ? { projectionHealth: { status: "error", message: error } }
        : {}),
    });
    if (change === "return to session") {
      await store.openSession("s2");
      await store.openSession("s1");
    }
    if (sameSession) socket.emitSnapshot(current);
    else await selectSession(store, current);
    old.resolve(
      change === "current authority 401"
        ? denied
        : sameSession
          ? unavailable
          : {
              body: activeSnapshot({
                pageMessages: [{ role: "assistant", content: "stale" }],
              }),
            },
    );
    await tick();
    expect(store.getState()).toMatchObject({
      sessionId,
      view: { viewId },
      error,
      live: { messages: [{ content: "current" }] },
      ...(change === "current authority 401"
        ? { needsToken: true, connection: "offline" }
        : { needsToken: false }),
    });
  },
);

it("recovers quiet snapshot failures and warns only when retries exhaust", async () => {
  const read = vi.fn<() => RouteResponse>().mockReturnValue(unavailable);
  installStoreRoutes((url) =>
    url.startsWith("/api/snapshot") ? read() : undefined,
  );
  const { store, socket } = await initStore();
  ready(socket);
  await tick();
  expect(store.getState()).toMatchObject({ connection: "open", error: null });
  read.mockReturnValueOnce({
    body: activeSnapshot({ sessionName: "Reobserved" }),
  });
  await tick(15_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.getState()).toMatchObject({
    sessionName: "Reobserved",
    error: null,
  });
  ready(socket);
  await tick();
  expect(store.getState().error).toBeNull();
  await tick(14_000);
  expect(store.getState()).toMatchObject({
    sessionName: "Reobserved",
    error:
      "Could not refresh this conversation. Showing the last loaded version.",
    errorSeverity: "warning",
  });
});
