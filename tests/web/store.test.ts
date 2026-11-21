import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HTTP_OBSERVATION_TIMEOUT_MS } from "../../src/api";
import { AppStore, shallowEqual, store, useAppState } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  emptySnapshot,
  FakeWebSocket,
  installFakeWebSocket,
  type RouteResponse,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";
import { initStore, installStoreRoutes } from "./store-fixture";

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const nextHost = "22222222-2222-4222-8222-222222222222";
const latestSocket = () => FakeWebSocket.instances.at(-1)!;
const textRows = (content: string) => [{ role: "assistant", content }];
const bootstrapPath = "/api/bootstrap";
const snapshotPath = "/api/snapshot";

beforeEach(() => installFakeWebSocket());
afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});

it("publishes branch ownership with its rows and orders HTTP and socket cuts only within one Host", async () => {
  let authorityId = TEST_HOST_AUTHORITY;
  const answer = deferred<RouteResponse>();
  const confirmed = {
    ...activeSnapshot({ pageMessages: textRows("Confirmed") }),
    runtimeSequence: 200,
  };
  const old = deferred<RouteResponse>();
  const read = vi
    .fn<() => Promise<RouteResponse>>()
    .mockReturnValueOnce(answer.promise)
    .mockReturnValueOnce(old.promise);
  installStoreRoutes((url) => {
    if (url.startsWith(bootstrapPath))
      return {
        body: bootstrapPayload({ authorityId, startupSessionId: "s1" }),
      };
    if (url.startsWith(snapshotPath)) return read();
  });
  const { store } = await initStore();
  const draft = "keep this draft";
  store.drafts.setText("s1", draft);
  await store.init();
  const waiting = latestSocket();
  waiting.open();
  const refreshing = store.refreshSession();
  answer.resolve({ body: confirmed });
  await refreshing;
  waiting.emitSnapshot(activeSnapshot(), { runtimeSequence: 199 });
  expect(store.getState()).toMatchObject({
    connection: "open",
    live: { messages: textRows("Confirmed") },
  });

  const seen: Array<[string | null, unknown]> = [];
  const unsubscribe = store.subscribe(() => {
    const { view, live } = store.getState();
    seen.push([view.viewId, live.messages.at(-1)?.content]);
  });
  try {
    const stale = store.refreshSession();
    const native = activeSnapshot({
      branchRevision: 2,
      durableLeafId: "native-leaf",
      transcriptPage: {
        viewId: "new-view",
        revision: 2,
        effectiveLeafId: "native-leaf",
        messages: textRows("Native text"),
      },
    });
    waiting.emit({
      type: "branch_changed",
      sessionId: "s1",
      runtimeSequence: 202,
      transcript: native.active,
    });
    old.resolve({ body: { ...confirmed, runtimeSequence: 201 } });
    await stale;
    expect(seen).toContainEqual(["new-view", "Native text"]);
    for (const [view, content] of seen)
      expect(view === "new-view").toBe(content === "Native text");
    expect(store.getState().view).toMatchObject({
      branchRevision: 2,
      effectiveLeafId: "native-leaf",
    });
    expect(store.drafts.get("s1").text).toBe(draft);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }

  authorityId = nextHost;
  await store.init();
  const replacement = latestSocket();
  replacement.join(activeSnapshot(), { authorityId });
  replacement.emit({
    type: "session_projection_changed",
    sessionId: "s1",
    runtimeSequence: 2,
    transcript: activeSnapshot({ pageMessages: textRows("After restart") })
      .active,
  });
  expect(store.getState().live.messages).toMatchObject(
    textRows("After restart"),
  );
});

it.each(["replacement", "deadline"] as const)(
  "ignores bootstrap retired by %s and retains the replacement Host's choices",
  async (reason) => {
    vi.useFakeTimers();
    const retired = deferred<RouteResponse>();
    const current = bootstrapPayload({
      authorityId: nextHost,
      version: "current-host",
      preferences: { ...DEFAULT_PREFS, theme: "dark" },
      startupSessionId: "current-session",
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
      ],
    });
    const bootstrap = vi
      .fn<
        (
          signal: RequestInit["signal"],
        ) => RouteResponse | Promise<RouteResponse>
      >()
      .mockReturnValueOnce(retired.promise)
      .mockReturnValue({ body: current });
    installStoreRoutes((url, init) =>
      url.startsWith(bootstrapPath) ? bootstrap(init.signal) : undefined,
    );
    const store = new AppStore();
    const first = store.init();
    if (reason === "deadline") {
      await tick(HTTP_OBSERVATION_TIMEOUT_MS);
      await first;
      expect(store.getState()).toMatchObject({
        bootstrapped: false,
        needsToken: false,
        connection: "offline",
        connectionProblem: { kind: "address-unreachable" },
      });
    }
    await store.init();
    await first;
    expect(bootstrap.mock.calls[0]![0]?.aborted).toBe(true);
    const socket = latestSocket();
    socket.join(activeSnapshot({ sessionId: "current-session" }), {
      authorityId: nextHost,
    });
    retired.resolve(
      reason === "deadline"
        ? { status: 401, body: { error: "Expired pairing" } }
        : { body: bootstrapPayload({ startupSessionId: "retired-session" }) },
    );
    await tick();
    expect(store.getState()).toMatchObject({
      connection: "open",
      sessionId: "current-session",
      version: "current-host",
      prefs: { theme: "dark" },
      availableModels: current.availableModels,
      needsToken: false,
    });
    expect(FakeWebSocket.instances).toEqual([socket]);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  },
);

it.each(["address-unreachable", "service-error"] as const)(
  "identifies %s without asking for pairing",
  async (kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (kind === "address-unreachable")
          throw new TypeError("Failed to fetch");
        return new Response("not an Inspire response");
      }),
    );
    const store = new AppStore();
    await store.init();
    expect(store.getState()).toMatchObject({
      needsToken: false,
      bootstrapped: false,
      connection: "offline",
      connectionProblem: { kind },
    });
  },
);

it.each(["committed", "pending"] as const)(
  "preserves a newer %s selection through missing-detail recovery",
  async (phase) => {
    const open = deferred<RouteResponse>();
    installStoreRoutes((url) =>
      url === "/api/sessions/open" ? open.promise : undefined,
    );
    const { store } = await initStore();
    await store.init();
    const socket = latestSocket();
    socket.open();
    const selecting = store.openSession("s2");
    const finish = () =>
      open.resolve({ body: activeSnapshot({ sessionId: "s2" }) });
    if (phase === "committed") {
      finish();
      await selecting;
    }
    socket.emitSnapshot(emptySnapshot, {
      detailSessionId: "s1",
      detailRevision: 0,
      missingDetail: true,
    });
    if (phase === "pending") {
      expect(store.getState()).toMatchObject({
        sessionId: null,
        openingSessionId: "s2",
        sessionSelectionPending: true,
      });
      finish();
      await selecting;
    }
    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().live.notices).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("previous session no longer exists"),
      }),
    );
  },
);

it("restores selected live state while background work updates only the catalog and its own draft", async () => {
  const fetch = installStoreRoutes(() => undefined);
  const { store, socket } = await initStore();
  const publish = (type: string, fields: Record<string, unknown>) =>
    socket.emit({ type, sessionId: "s1", ...fields });
  publish("extension_ui_request", {
    id: "title",
    method: "setTitle",
    title: "Session A title",
  });
  publish("extension_ui_request", {
    id: "status",
    method: "setStatus",
    extensionStatuses: { worker: "indexing" },
  });
  publish("extension_ui_request", {
    id: "editor",
    method: "set_editor_text",
    text: "Draft from A",
  });
  expect(store.getState().live).toMatchObject({
    windowTitle: "Session A title",
    statuses: { worker: "indexing" },
  });
  await selectSession(store, activeSnapshot({ sessionId: "s2" }));
  expect(store.getState().live).toMatchObject({
    windowTitle: null,
    statuses: {},
  });
  expect(store.drafts.get("s1").text).toBe("Draft from A");
  expect(store.drafts.get("s2").text).toBe("");

  const listReads = () =>
    fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/sessions?"))
      .length;
  const before = listReads();
  const busy = { runState: "running", indicator: "running" };
  publish("message_start", {
    message: textRows("background output")[0],
    sessionStatus: busy,
  });
  expect(store.getState().sessionStatuses.s1).toEqual(busy);
  const observed = vi.fn();
  const unsubscribe = store.subscribe(observed);
  try {
    publish("message_update", {
      message: textRows("more tokens")[0],
      sessionStatus: busy,
    });
    expect(observed).not.toHaveBeenCalled();
    for (const needsInput of [true, false]) {
      publish("session_status", {
        sessionStatus: { ...busy, indicator: "attention", needsInput },
      });
      expect(store.getState().sessionStatuses.s1.needsInput).toBe(needsInput);
    }
    publish("runtime_ready", { sessionStatus: { runState: "idle" } });
    const completed = { runState: "idle", indicator: "completed" };
    publish("agent_settled", { sessionStatus: completed });
    await vi.waitFor(() => expect(listReads()).toBe(before + 1));
    expect(
      fetch.mock.calls.some(([url]) => String(url).startsWith(snapshotPath)),
    ).toBe(false);
    expect(store.getState()).toMatchObject({
      sessionStatuses: { s1: completed },
      live: { messages: [], streaming: false, extensionUiRequests: [] },
    });
  } finally {
    unsubscribe();
  }
});

it("keeps confirmed diagnostics through failed reads, ignores incomplete replacement and recovers on reconnect", async () => {
  vi.useFakeTimers();
  const denied = { status: 503, body: { error: "Snapshot unavailable" } };
  const accepted = {
    ...activeSnapshot({
      pageMessages: textRows("Recovered"),
      transcriptPage: { revision: 3, appendFromRevision: 2 },
    }),
    runtimeSequence: 3,
  };
  const refresh = vi
    .fn<() => RouteResponse>()
    .mockReturnValueOnce(denied)
    .mockReturnValue({ body: accepted });
  installStoreRoutes((url) =>
    url.startsWith(snapshotPath) ? refresh() : undefined,
  );
  const { store, socket } = await initStore();
  const conflict = {
    kind: "projection-failure" as const,
    message: "The projection changed on disk",
    revision: 2,
    incidentId: "incident-ownership",
  };
  socket.emit({
    type: "session_projection_changed",
    sessionId: "s1",
    runtimeSequence: 2,
    sessionStatus: { runState: "conflict" },
    transcript: activeSnapshot({
      projectionHealth: {
        status: "error",
        message: "malformed persisted line",
      },
      projectionConflict: conflict,
      transcriptPage: { revision: 2, appendFromRevision: 2 },
    }).active,
  });
  expect(store.getState()).toMatchObject({
    error: conflict.message,
    errorSeverity: "error",
    view: { revision: 2, conflict },
  });
  expect(refresh).not.toHaveBeenCalled();
  socket.emit({ type: "runtime_ready", sessionId: "s1", runtimeSequence: 3 });
  await tick();
  expect(refresh).toHaveBeenCalledOnce();
  expect(store.getState().error).toBe(conflict.message);
  await tick(1_000);
  expect(store.getState()).toMatchObject({
    error: null,
    view: { revision: 3, health: { status: "ok" } },
    live: { messages: textRows("Recovered") },
  });

  socket.emit({
    type: "session_projection_changed",
    sessionId: "s1",
    health: { status: "error", message: "Invalid partial diagnostic" },
  });
  expect(store.getState()).toMatchObject({
    connection: "reconnecting",
    view: { revision: 3, health: { status: "ok" } },
    error: null,
  });
  await tick(1_000);
  latestSocket().join({
    ...activeSnapshot({
      pageMessages: textRows("Confirmed on reconnect"),
      transcriptPage: { revision: 4 },
    }),
    runtimeSequence: 4,
  });
  expect(store.getState()).toMatchObject({
    connection: "open",
    live: { messages: textRows("Confirmed on reconnect") },
  });
});

it("clears Pending once and preserves newer queue events when its receipt arrives", async () => {
  const clear = deferred<RouteResponse>();
  const fetch = installStoreRoutes((url) =>
    url === "/api/pending/clear" ? clear.promise : undefined,
  );
  const { store, socket } = await initStore();
  const queue = pendingQueues(["one"]);
  socket.emitSnapshot({ ...activeSnapshot(), pendingQueues: queue });
  const clearing = store.clearPending();
  await expect(store.clearPending()).resolves.toBe(false);
  expect(store.getState().live.queue).toEqual(queue);
  const newer = pendingQueues(["arrived after clear"], [], { revision: 2 });
  socket.emit({ type: "queue_update", sessionId: "s1", pendingQueues: newer });
  clear.resolve({ body: { ok: true } });
  await expect(clearing).resolves.toBe(true);
  expect(
    fetch.mock.calls.filter(([url]) => url === "/api/pending/clear"),
  ).toEqual([
    [
      "/api/pending/clear",
      expect.objectContaining({ body: JSON.stringify({ sessionId: "s1" }) }),
    ],
  ]);
  expect(store.getState()).toMatchObject({
    pendingAction: null,
    live: { queue: newer },
  });
});

it("rerenders a shallow selection only when a selected value changes", () => {
  const rendered = vi.fn();
  function ResourceProbe() {
    const { open } = useAppState(
      (state) => ({ open: state.resourcesOpen, sessionId: state.sessionId }),
      shallowEqual,
    );
    rendered();
    return createElement(
      "output",
      null,
      open ? "Resources open" : "Resources closed",
    );
  }
  render(createElement(ResourceProbe));
  const initial = rendered.mock.calls.length;
  act(() => store.workspace.setQuery("notes"));
  expect(rendered).toHaveBeenCalledTimes(initial);
  act(() => store.setResourcesOpen(true));
  expect(screen.getByRole("status")).toHaveTextContent("Resources open");
  cleanup();
  store.workspace.setQuery("");
  store.setResourcesOpen(false);
});
