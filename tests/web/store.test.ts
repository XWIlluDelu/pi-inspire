// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  TEST_SNAPSHOT_DIGEST,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";

import { baseRoutes, initStore, requestToken } from "./store-fixture";

function installDeferredBootstrapRoutes(...tokens: string[]) {
  const responses = new Map(
    tokens.map((token) => [token, deferred<RouteResponse>()] as const),
  );
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) {
      const token = requestToken(init);
      const response = token ? responses.get(token) : undefined;
      if (!response)
        throw new Error("Unexpected bootstrap token in deferred test");
      return response.promise;
    }
    return baseRoutes(url, init);
  });
  return responses;
}

describe("websocket lifecycle", () => {
  it("commits selection interest on the existing socket and addresses resync and fallback bootstrap", async () => {
    const reads: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/sessions/open"))
        return { body: activeSnapshot({ sessionId: "s2" }) };
      if (url.startsWith("/api/snapshot") || url.startsWith("/api/bootstrap"))
        reads.push(url);
      if (url.includes("detail=s2"))
        return {
          body: url.startsWith("/api/bootstrap")
            ? bootstrapPayload({
                snapshot: activeSnapshot({ sessionId: "s2" }),
              })
            : activeSnapshot({ sessionId: "s2" }),
        };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.openSession("s2");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "detail_interest",
      sessionId: "s2",
      revision: 1,
    });
    socket.emit({
      type: "snapshot",
      detailSessionId: "s1",
      detailRevision: 0,
      data: activeSnapshot(),
    });
    expect(store.getState().sessionId).toBe("s2");
    socket.emit({
      type: "snapshot",
      detailSessionId: "s2",
      detailRevision: 1,
      data: activeSnapshot({ sessionId: "s2" }),
    });
    socket.emit({
      type: "runtime_ready",
      sessionId: "s2",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(reads).toContain("/api/snapshot?detail=s2"));
    await store.init(null);
    expect(reads).toContain("/api/bootstrap?detail=s2");
    expect(
      new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get("detail"),
    ).toBe("s2");
  });

  beforeEach(() => installFakeWebSocket());

  it("uses the host pairing cookie without retaining a bearer in the PWA window", async () => {
    const fetch = installFetch(baseRoutes);
    const store = new AppStore();
    await store.init(null);
    const socket = FakeWebSocket.instances.at(-1)!;

    const bootstrapCall = fetch.mock.calls.find(([url]) =>
      String(url).startsWith("/api/bootstrap"),
    );
    expect(bootstrapCall?.[1]).toMatchObject({ credentials: "same-origin" });
    expect(bootstrapCall?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(socket.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=s1`,
    );
  });

  it("retires a launch bearer after bootstrap establishes the pairing cookie", async () => {
    const fetch = installFetch(baseRoutes);
    const store = new AppStore();
    await store.init("launch-token");
    await store.refreshSessions();

    const bootstrapCall = fetch.mock.calls.find(([url]) =>
      String(url).startsWith("/api/bootstrap"),
    );
    expect(bootstrapCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer launch-token",
    });
    const sessionCalls = fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/sessions"),
    );
    expect(sessionCalls.length).toBeGreaterThan(0);
    expect(
      sessionCalls.every(([, init]) => requestToken(init ?? {}) === null),
    ).toBe(true);
    expect(FakeWebSocket.instances.at(-1)?.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=s1`,
    );
  });

  it("applies only the latest of concurrent bootstrap successes", async () => {
    const bootstraps = installDeferredBootstrapRoutes("old", "new");
    const store = new AppStore();
    const oldInit = store.init("old");
    const newInit = store.init("new");

    bootstraps.get("new")!.resolve({
      body: bootstrapPayload({
        version: "new-host",
        snapshot: activeSnapshot({ sessionId: "new-session" }),
      }),
    });
    await newInit;
    bootstraps.get("old")!.resolve({
      body: bootstrapPayload({
        version: "old-host",
        snapshot: activeSnapshot({ sessionId: "old-session" }),
      }),
    });
    await oldInit;

    expect(store.getState()).toMatchObject({
      version: "new-host",
      sessionId: "new-session",
      needsToken: false,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=new-session`,
    );
  });

  it("ignores a superseded bootstrap authorization failure", async () => {
    const bootstraps = installDeferredBootstrapRoutes("expired", "fresh");
    const store = new AppStore();
    const expiredInit = store.init("expired");
    const freshInit = store.init("fresh");

    bootstraps.get("fresh")!.resolve({
      body: bootstrapPayload({
        version: "fresh-host",
        snapshot: activeSnapshot({ sessionId: "fresh-session" }),
      }),
    });
    await freshInit;
    bootstraps.get("expired")!.resolve({
      status: 401,
      body: { error: "expired token" },
    });
    await expiredInit;

    expect(store.getState()).toMatchObject({
      version: "fresh-host",
      sessionId: "fresh-session",
      needsToken: false,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=fresh-session`,
    );
  });

  it("prevents a superseded bootstrap from replacing current preferences or its socket", async () => {
    const bootstraps = installDeferredBootstrapRoutes("old", "new");
    const store = new AppStore();
    const oldInit = store.init("old");
    const newInit = store.init("new");

    bootstraps.get("new")!.resolve({
      body: bootstrapPayload({
        preferences: { ...DEFAULT_PREFS, theme: "dark" },
        snapshot: activeSnapshot({ sessionId: "new-session" }),
      }),
    });
    await newInit;
    const currentSocket = FakeWebSocket.instances[0];
    bootstraps.get("old")!.resolve({
      body: bootstrapPayload({
        preferences: { ...DEFAULT_PREFS, theme: "light" },
        snapshot: activeSnapshot({ sessionId: "old-session" }),
      }),
    });
    await oldInit;

    expect(store.getState()).toMatchObject({
      sessionId: "new-session",
      prefs: { theme: "dark" },
    });
    expect(FakeWebSocket.instances).toEqual([currentSocket]);
  });

  it("distinguishes an unreachable address from a host that requires pairing", async () => {
    vi.useFakeTimers();
    try {
      installFetch(() => {
        throw new TypeError("Failed to fetch");
      });
      const store = new AppStore();
      await store.init(null);
      expect(store.getState()).toMatchObject({
        needsToken: false,
        bootstrapped: false,
        connection: "offline",
        connectionProblem: { kind: "address-unreachable" },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("distinguishes an answered address with an invalid Host response", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response("not an INSΠRE response", {
              status: 200,
              headers: { "Content-Type": "text/plain" },
            }),
          ),
        ),
      );
      const store = new AppStore();
      await store.init(null);
      expect(store.getState()).toMatchObject({
        needsToken: false,
        bootstrapped: false,
        connection: "offline",
        connectionProblem: {
          kind: "service-error",
          message: "The INSΠRE address returned an invalid response",
        },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns an established view to Pair when reconnect authentication expires", async () => {
    vi.useFakeTimers();
    try {
      let expired = false;
      installFetch((url, init) => {
        if (expired && url.startsWith("/api/bootstrap"))
          return { status: 401, body: { error: "pairing expired" } };
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();

      expired = true;
      socket.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      const resumedSocket = FakeWebSocket.instances[1]!;
      expect(resumedSocket.url).toContain(`snapshot=${TEST_SNAPSHOT_DIGEST}`);

      // The cheap event-stream resume is tried before HTTP bootstrap. If that
      // path cannot complete, the next backoff step revalidates pairing.
      resumedSocket.onclose?.();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(store.getState()).toMatchObject({
        needsToken: true,
        connection: "offline",
        connectionProblem: null,
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("bounds a bootstrap that never produces an HTTP response", async () => {
    vi.useFakeTimers();
    try {
      const bootstrapSignals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          if (!String(input).startsWith("/api/bootstrap"))
            return Promise.resolve(
              Response.json({ error: "unexpected request" }, { status: 500 }),
            );
          const bootstrapSignal = init?.signal;
          if (!bootstrapSignal)
            throw new Error("Bootstrap request did not carry a signal");
          bootstrapSignals.push(bootstrapSignal);
          return new Promise<Response>((_resolve, reject) => {
            const abort = () =>
              reject(new DOMException("Bootstrap timed out", "AbortError"));
            if (bootstrapSignal.aborted) abort();
            else
              bootstrapSignal.addEventListener("abort", abort, {
                once: true,
              });
          });
        }),
      );
      const store = new AppStore();
      const initializing = store.init(null);

      await vi.advanceTimersByTimeAsync(15_000);
      await initializing;

      expect(bootstrapSignals[0]?.aborted).toBe(true);
      expect(store.getState()).toMatchObject({
        bootstrapped: false,
        connection: "offline",
        connectionProblem: { kind: "address-unreachable" },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("retains bootstrap model choices while an active preview has not loaded its worker catalog", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
    ];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            availableModels: models,
            snapshot: activeSnapshot({ availableModels: [] }),
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().availableModels).toEqual(models);
  });

  it("does not issue an HTTP resync on open; the pushed snapshot is authoritative", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) snapshotCalls += 1;
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    expect(snapshotCalls).toBe(0);
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s9" }),
    });
    expect(store.getState().sessionId).toBe("s9");
    expect(snapshotCalls).toBe(0);
  });
});

describe("multi-session event routing", () => {
  beforeEach(() => installFakeWebSocket());

  it("surfaces projection health and conflict state from authoritative snapshots", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        projectionHealth: { status: "error", message: "wrong session header" },
        projectionConflict: {
          kind: "external-change",
          message: "external writer conflict",
          revision: 3,
          incidentId: "incident-external-writer",
        },
      }),
    });
    expect(store.getState().projectionHealth).toMatchObject({
      status: "error",
    });
    expect(store.getState().projectionConflict).toMatchObject({ revision: 3 });
    expect(store.getState().error).toBe("external writer conflict");
  });

  it("applies snapshot sessionStatuses wholesale into state", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    expect(store.getState().sessionStatuses).toEqual({
      s1: { runState: "idle" },
    });
    const snapshot = activeSnapshot();
    snapshot.sessionStatuses = {
      s1: { runState: "idle" },
      s2: { runState: "idle", indicator: "completed" },
    };
    if (snapshot.active)
      snapshot.active.activeAssistantMessageKey = "persisted:a1:0";
    snapshot.pendingExtensionUiRequests = [
      {
        sessionId: "s1",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
      },
    ];
    snapshot.pendingQueues = pendingQueues(
      ["correct the current answer"],
      ["then add tests", "then summarize"],
      { revision: 2 },
    );
    snapshot.extensionDisplays = [
      {
        id: "setWidget:plan",
        kind: "widget",
        label: "plan",
        source: "Pi extension",
        placement: "aboveEditor",
        lines: ["step"],
      },
    ];
    snapshot.extensionStatuses = { usage: "37%" };
    socket.emit({ type: "snapshot", data: snapshot });
    expect(store.getState().sessionStatuses).toEqual({
      s1: { runState: "idle" },
      s2: { runState: "idle", indicator: "completed" },
    });
    expect(store.getState().extensionUiRequests).toEqual([
      {
        sessionId: "s1",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
      },
    ]);
    expect(store.getState().queue).toEqual(snapshot.pendingQueues);
    expect(store.getState().extensionDisplays).toHaveLength(1);
    expect(store.getState().statuses).toEqual({ usage: "37%" });
    expect(store.getState().activeAssistantMessageKey).toBe("persisted:a1:0");

    if (snapshot.active) snapshot.active.activeAssistantMessageKey = null;
    snapshot.pendingExtensionUiRequests = [];
    snapshot.pendingQueues = pendingQueues();
    snapshot.extensionDisplays = [];
    snapshot.extensionStatuses = {};
    socket.emit({ type: "snapshot", data: snapshot });
    expect(store.getState().extensionUiRequests).toEqual([]);
    expect(store.getState().queue).toEqual(snapshot.pendingQueues);
    expect(store.getState().extensionDisplays).toEqual([]);
    expect(store.getState().statuses).toEqual({});
    expect(store.getState().activeAssistantMessageKey).toBeNull();
  });

  it("drops malformed extension displays from authoritative snapshots", async () => {
    const { store, socket } = await initStore();
    const snapshot = activeSnapshot();
    const valid = {
      id: "setWidget:valid",
      kind: "widget",
      label: "valid",
      source: "Pi extension",
      placement: "aboveEditor",
      lines: ["kept"],
    };
    (
      snapshot as unknown as {
        extensionDisplays: unknown;
      }
    ).extensionDisplays = [
      valid,
      { ...valid, id: "bad-lines", lines: "not-an-array" },
      { ...valid, id: "bad-placement", placement: "sidebar" },
      {
        ...valid,
        id: "too-many-lines",
        lines: Array.from({ length: 201 }, () => "line"),
      },
      {
        id: "raw-without-method",
        kind: "raw",
        label: "raw",
        source: "Pi extension",
        placement: "aboveEditor",
        payload: {},
      },
    ];

    socket.emit({ type: "snapshot", data: snapshot });

    expect(store.getState().extensionDisplays).toEqual([valid]);
  });

  it("clears selected-only extension presentation when switching sessions", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "status-1",
      method: "setStatus",
      statusKey: "worker",
      statusText: "indexing",
    });
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "title-1",
      method: "setTitle",
      title: "Session A title",
    });
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "editor-1",
      method: "set_editor_text",
      text: "draft from A",
    });
    expect(store.getState()).toMatchObject({
      statuses: { worker: "indexing" },
      windowTitle: "Session A title",
      editorText: { text: "draft from A", nonce: 1 },
    });

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
    });
    expect(store.getState()).toMatchObject({
      statuses: {},
      windowTitle: null,
      editorText: null,
    });
  });

  it("routes background deltas only to the status map, never the visible transcript", async () => {
    let snapshotCalls = 0;
    let sessionListCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) snapshotCalls += 1;
      if (url.startsWith("/api/sessions?")) sessionListCalls += 1;
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const sessionsAfterInit = sessionListCalls;

    socket.emit({
      type: "message_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
      message: {
        role: "assistant",
        content: "background draft",
        timestamp: 42,
      },
    });
    expect(store.getState().messages).toEqual([]); // visible transcript untouched
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().sessionStatuses.bg).toEqual({
      runState: "running",
      indicator: "running",
    });
    expect(listener).toHaveBeenCalledTimes(1); // the status change publishes once

    // unchanged background status (token chatter) publishes nothing
    listener.mockClear();
    socket.emit({
      type: "message_update",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
      message: {
        role: "assistant",
        content: "background draft continues",
        timestamp: 42,
      },
    });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().messages).toEqual([]);

    socket.emit({
      type: "session_status",
      sessionId: "bg",
      sessionStatus: {
        runState: "running",
        indicator: "attention",
        needsInput: true,
      },
    });
    expect(store.getState().sessionStatuses.bg.needsInput).toBe(true);
    expect(store.getState().extensionUiRequests).toEqual([]);
    socket.emit({
      type: "session_status",
      sessionId: "bg",
      sessionStatus: {
        runState: "running",
        indicator: "attention",
        needsInput: false,
      },
    });
    expect(store.getState().sessionStatuses.bg.needsInput).toBe(false);

    socket.emit({
      type: "runtime_ready",
      sessionId: "bg",
      sessionStatus: { runState: "idle" },
    });
    expect(snapshotCalls).toBe(0);

    // a background settle updates the status and refreshes the session list
    // once, but never resyncs the selected transcript
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    await vi.waitFor(() =>
      expect(sessionListCalls).toBe(sessionsAfterInit + 1),
    );
    expect(snapshotCalls).toBe(0);
    expect(store.getState().sessionStatuses.bg).toEqual({
      runState: "idle",
      indicator: "completed",
    });
    expect(store.getState().messages).toEqual([]);
  });

  it("resyncs an addressed selected projection change but isolates a background projection", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({
            pageMessages: [
              { role: "assistant", content: "projected", timestamp: 8 },
            ],
            transcriptPage: {
              sessionId: "s1",
              revision: 2,
              incarnation: "projection-1",
              appendFromRevision: 1,
              messages: [
                { role: "assistant", content: "projected", timestamp: 8 },
              ],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_changed",
      sessionId: "background",
      revision: 2,
      sessionStatus: { runState: "idle" },
    });
    expect(snapshotCalls).toBe(0);
    expect(store.getState().messages).toEqual([]);
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 2,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    await vi.waitFor(() =>
      expect(store.getState().messages).toEqual([
        { role: "assistant", content: "projected", timestamp: 8 },
      ]),
    );
  });

  it("applies only the newest reordered same-session resync response", async () => {
    const { promise: first, resolve: releaseFirst } = deferred<void>();
    const { promise: second, resolve: releaseSecond } = deferred<void>();
    let calls = 0;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/snapshot")) {
        calls += 1;
        const call = calls;
        await (call === 1 ? first : second);
        return {
          body: activeSnapshot({
            transcriptPage: {
              sessionId: "s1",
              revision: call === 1 ? 2 : 3,
              incarnation: "projection-1",
              appendFromRevision: 1,
              messages: [
                {
                  role: "assistant",
                  content: call === 1 ? "revision 2" : "revision 3",
                  timestamp: call,
                },
              ],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 2,
      sessionStatus: { runState: "idle" },
    });
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 3,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    releaseSecond();
    await vi.waitFor(() => expect(store.getState().transcriptRevision).toBe(3));
    releaseFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getState().transcriptRevision).toBe(3);
    expect(store.getState().messages.at(-1)?.content).toBe("revision 3");
  });

  it("surfaces projection health immediately and retains it when non-auth resync fails", async () => {
    let snapshots = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) {
        snapshots += 1;
        return { status: 503, body: { error: "snapshot unavailable" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 2,
      health: { status: "error", message: "malformed persisted line" },
      conflict: null,
      sessionStatus: { runState: "idle" },
    });
    expect(store.getState().projectionHealth).toEqual({
      status: "error",
      message: "malformed persisted line",
    });
    expect(store.getState().projectionError).toBe("malformed persisted line");
    expect(store.getState().error).toBe("malformed persisted line");
    await vi.waitFor(() => expect(snapshots).toBe(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getState().error).toBe("malformed persisted line");
  });

  it("clears only the projection-owned alert when projection health recovers", async () => {
    const { promise: snapshots, resolve: releaseSnapshots } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/snapshot")) {
        await snapshots;
        return {
          body: activeSnapshot({
            projectionHealth: { status: "ok" },
            projectionConflict: null,
            transcriptPage: {
              sessionId: "s1",
              revision: 3,
              incarnation: "projection-1",
              appendFromRevision: 2,
              messages: [],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 2,
      health: { status: "error", message: "malformed persisted line" },
      conflict: null,
      sessionStatus: { runState: "idle" },
    });
    expect(store.getState().error).toBe("malformed persisted line");

    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 3,
      health: { status: "ok" },
      conflict: null,
      sessionStatus: { runState: "idle" },
    });
    expect(store.getState().projectionError).toBeNull();
    expect(store.getState().error).toBeNull();

    releaseSnapshots();
    await vi.waitFor(() => expect(store.getState().transcriptRevision).toBe(3));
    expect(store.getState().projectionError).toBeNull();
    expect(store.getState().error).toBeNull();
  });

  it("preserves conflict and projection-health visibility through event-driven resync", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot"))
        return {
          body: activeSnapshot({
            projectionHealth: {
              status: "error",
              message: "malformed replacement",
            },
            projectionConflict: {
              kind: "projection-failure",
              message: "ownership conflict",
              revision: 2,
              incidentId: "incident-ownership",
            },
            transcriptPage: {
              sessionId: "s1",
              revision: 2,
              incarnation: "projection-1",
              appendFromRevision: 2,
              messages: [],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_conflict",
      sessionId: "s1",
      conflict: { message: "ownership conflict", revision: 2 },
      sessionStatus: { runState: "conflict" },
    });
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 2,
      sessionStatus: { runState: "conflict" },
    });
    await vi.waitFor(() =>
      expect(store.getState().projectionHealth.status).toBe("error"),
    );
    expect(store.getState().projectionConflict?.message).toBe(
      "ownership conflict",
    );
    expect(store.getState().runState).toBe("conflict");
    expect(store.getState().error).toBe("ownership conflict");
  });

  it.each([
    ["external-change", { status: "ok" as const }, "warning"],
    [
      "projection-failure",
      { status: "error" as const, message: "damaged projection" },
      "error",
    ],
  ] as const)(
    "keeps %s severity when event-driven resync fails",
    async (kind, health, expectedSeverity) => {
      let snapshotCalls = 0;
      const { promise: failedSnapshot, resolve: releaseSnapshot } =
        deferred<RouteResponse>();
      installFetch((url, init) => {
        if (url.startsWith("/api/snapshot")) {
          snapshotCalls += 1;
          return failedSnapshot;
        }
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      const conflict = { kind, message: `${kind} conflict`, revision: 2 };
      socket.emit({
        type: "session_projection_conflict",
        sessionId: "s1",
        conflict,
        sessionStatus: { runState: "conflict" },
      });
      let updatesAfterFailure = 0;
      const unsubscribe = store.subscribe(() => {
        updatesAfterFailure += 1;
      });
      socket.emit({
        type: "session_projection_changed",
        sessionId: "s1",
        revision: 2,
        health,
        conflict,
        sessionStatus: { runState: "conflict" },
      });
      await vi.waitFor(() => expect(snapshotCalls).toBe(1));
      updatesAfterFailure = 0;
      releaseSnapshot({ status: 503, body: { error: "snapshot unavailable" } });
      await vi.waitFor(() => expect(updatesAfterFailure).toBeGreaterThan(0));
      expect(store.getState().errorSeverity).toBe(expectedSeverity);
      expect(store.getState().error).toBe(`${kind} conflict`);
      unsubscribe();
    },
  );

  it("clears Pending without replacing newer queue events with a receipt", async () => {
    const requests: Record<string, unknown>[] = [];
    let finish!: (value: { body: { ok: boolean } }) => void;
    installFetch((url, init) => {
      if (url === "/api/pending/clear") {
        requests.push(jsonBody(init));
        return new Promise<{ body: { ok: boolean } }>((resolve) => {
          finish = resolve;
        });
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const active = activeSnapshot();
    active.pendingQueues = pendingQueues(["one"]);
    socket.emit({ type: "snapshot", data: active });
    const clearing = store.clearPending();
    await vi.waitFor(() => expect(requests).toEqual([{ sessionId: "s1" }]));
    await expect(store.clearPending()).resolves.toBe(false);
    expect(store.getState().queue).toEqual(active.pendingQueues);
    const newer = pendingQueues(["arrived after clear"], [], { revision: 2 });
    socket.emit({
      type: "queue_update",
      sessionId: "s1",
      pendingQueues: newer,
    });
    finish({ body: { ok: true } });
    await expect(clearing).resolves.toBe(true);
    expect(store.getState().queue).toEqual(newer);
    expect(store.getState().pendingAction).toBeNull();
  });

  it("reconciles a selected preview when its runtime becomes ready", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({
            pageMessages: [
              { role: "assistant", content: "live runtime", timestamp: 2 },
            ],
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    socket.emit({
      type: "runtime_ready",
      sessionId: "s1",
      sessionStatus: { runState: "idle" },
    });

    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    await vi.waitFor(() =>
      expect(store.getState().messages).toEqual([
        { role: "assistant", content: "live runtime", timestamp: 2 },
      ]),
    );
  });

  it("reconciles readiness that arrives before the open response", async () => {
    const { promise: openGate, resolve: releaseOpen } = deferred<void>();
    let openRequested = false;
    let snapshotCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          openRequested = true;
          await openGate;
          return new Response(
            JSON.stringify(
              activeSnapshot({
                sessionId: "s2",
                pageMessages: [
                  { role: "assistant", content: "preview B", timestamp: 2 },
                ],
              }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith("/api/snapshot")) {
          snapshotCalls += 1;
          return new Response(
            JSON.stringify(
              activeSnapshot({
                sessionId: "s2",
                pageMessages: [
                  { role: "assistant", content: "live B", timestamp: 3 },
                ],
              }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const route = (await baseRoutes(url, init ?? {})) ?? {
          status: 404,
          body: { error: "missing route" },
        };
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { store, socket } = await initStore();
    const opening = store.openSession("s2");
    await vi.waitFor(() => expect(openRequested).toBe(true));
    expect(store.getState().openingSessionId).toBe("s2");

    socket.emit({
      type: "runtime_ready",
      sessionId: "s2",
      sessionStatus: { runState: "idle" },
    });
    releaseOpen();
    await opening;

    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    await vi.waitFor(() =>
      expect(store.getState().messages).toEqual([
        { role: "assistant", content: "live B", timestamp: 3 },
      ]),
    );
  });

  it("does not let a delayed resync replace a newer session selection", async () => {
    const { promise: snapshotGate, resolve: releaseSnapshot } =
      deferred<void>();
    let snapshotRequested = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/snapshot")) {
          snapshotRequested = true;
          await snapshotGate;
          return new Response(
            JSON.stringify(
              activeSnapshot({
                sessionId: "s1",
                pageMessages: [
                  { role: "assistant", content: "stale A", timestamp: 3 },
                ],
              }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const route = (await baseRoutes(url, init ?? {})) ?? {
          status: 404,
          body: { error: "missing route" },
        };
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { store, socket } = await initStore();
    socket.emit({
      type: "runtime_ready",
      sessionId: "s1",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(snapshotRequested).toBe(true));

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "s2",
        sessionName: "Session B",
        pageMessages: [
          { role: "assistant", content: "current B", timestamp: 4 },
        ],
      }),
    });
    releaseSnapshot();
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("s2"));
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));

    expect(store.getState().messages).toEqual([
      { role: "assistant", content: "current B", timestamp: 4 },
    ]);
  });

  it("keeps extension responses bound to their owning session across navigation", async () => {
    const { promise: responseGate, resolve: releaseResponse } =
      deferred<void>();
    let responseBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/extension-ui")) {
          responseBody = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          await responseGate;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const route = (await baseRoutes(url, init ?? {})) ?? {
          status: 404,
          body: { error: "missing route" },
        };
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "question-a",
      method: "confirm",
      title: "Question A",
    });

    const responding = store.respondExtensionUi({
      id: "question-a",
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(responseBody).toMatchObject({ sessionId: "s1", id: "question-a" }),
    );
    const sessionB = activeSnapshot({
      sessionId: "s2",
      sessionName: "Session B",
    });
    sessionB.pendingExtensionUiRequests = [
      {
        sessionId: "s2",
        id: "question-b",
        method: "confirm",
        title: "Question B",
      },
    ];
    socket.emit({ type: "snapshot", data: sessionB });
    releaseResponse();
    await responding;

    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().extensionUiRequests).toEqual([
      expect.objectContaining({ sessionId: "s2", id: "question-b" }),
    ]);
  });

  it("keeps selected-session events flowing through the transcript reducer", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    socket.emit({
      type: "message_start",
      sessionId: "s1",
      sessionStatus: { runState: "running", indicator: "running" },
      message: { role: "assistant", content: "visible reply", timestamp: 7 },
    });
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().streaming).toBe(true);
    // the selected session's own status merges into the map as well
    expect(store.getState().sessionStatuses.s1).toEqual({
      runState: "running",
      indicator: "running",
    });
  });
});
