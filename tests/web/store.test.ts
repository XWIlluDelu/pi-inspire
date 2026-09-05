// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeSettings } from "../../shared/contracts";
import {
  injectHtmlPreviewCsp,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
} from "../../src/resource-preview";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
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
  type RouteHandler,
  type RouteResponse,
  sessionSummary,
  TEST_SNAPSHOT_DIGEST,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions"))
    return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

function requestToken(init: RequestInit): string | null {
  const authorization = (init.headers as Record<string, string> | undefined)
    ?.Authorization;
  return authorization?.replace(/^Bearer /u, "") ?? null;
}

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

async function initStore(): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open(FakeWebSocket.bootstrapSnapshot ?? activeSnapshot());
  return { store, socket };
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

describe("transcript paging", () => {
  beforeEach(() => installFakeWebSocket());

  it("prepends addressed older messages with dedupe and advances the cursor", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              pageMessages: [{ role: "user", content: "new", timestamp: 2 }],
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            messages: [
              { role: "user", content: "old", timestamp: 1 },
              { role: "user", content: "new duplicate", timestamp: 2 },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2]);
    expect(store.getState().hasOlderMessages).toBe(false);
    expect(store.getState().olderMessagesCursor).toBeNull();
    expect(store.getState().olderMessagesError).toBeNull();
  });

  it("loads the bounded user-turn outline and directly merges a selected turn with continuation", async () => {
    const requestedTurnCursors: Array<string | null> = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                messages: [
                  {
                    role: "user",
                    content: "latest",
                    timestamp: 10,
                    __inspireMessageId: "u2",
                    __inspireMessageIndex: 10,
                    __inspireUserTurnId: "u2",
                    __inspireUserTurnIndex: 2,
                  },
                ],
                hasOlder: true,
                olderCursor: "older-latest",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            total: 3,
            start: 0,
            turns: [
              { id: "u0", ordinal: 0, snippet: "old", attachmentCount: 0 },
              { id: "u1", ordinal: 1, snippet: "middle", attachmentCount: 0 },
              { id: "u2", ordinal: 2, snippet: "latest", attachmentCount: 0 },
            ],
          },
        };
      }
      if (url.startsWith("/api/transcript/user-turn?")) {
        const cursor = new URL(url, "http://localhost").searchParams.get(
          "cursor",
        );
        requestedTurnCursors.push(cursor);
        const continuation = cursor === "continue-turn";
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            messages: continuation
              ? [
                  {
                    role: "assistant",
                    content: "continued response",
                    timestamp: 3,
                    __inspireMessageId: "a0-continued",
                    __inspireMessageIndex: 2,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                ]
              : [
                  {
                    role: "user",
                    content: "old",
                    timestamp: 1,
                    __inspireMessageId: "u0",
                    __inspireMessageIndex: 0,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                  {
                    role: "assistant",
                    content: "response",
                    timestamp: 2,
                    __inspireMessageId: "a0",
                    __inspireMessageIndex: 1,
                    __inspireUserTurnId: "u0",
                    __inspireUserTurnIndex: 0,
                  },
                ],
            hasOlder: false,
            olderCursor: null,
            targetMessageId: "u0",
            rangeStart: 0,
            rangeEnd: continuation ? 3 : 2,
            hasMoreInTurn: !continuation,
            continuationCursor: continuation ? null : "continue-turn",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadPromptMapTurns();
    expect(store.getState()).toMatchObject({
      promptMapTotal: 3,
      promptMapLoadedStarts: [0],
      promptMapError: null,
    });
    expect(await store.navigatePromptMapTurn(2)).toBe(true);
    expect(store.getState().promptMapNavigatingOrdinal).toBeNull();
    expect(await store.navigatePromptMapTurn(0)).toBe(true);
    expect(requestedTurnCursors).toEqual([null, "continue-turn"]);
    expect(
      store.getState().messages.map((message) => message.__inspireMessageIndex),
    ).toEqual([0, 1, 2, 10]);
    expect(store.getState().promptMapNavigatingOrdinal).toBeNull();
  });

  it("keeps a newer prompt-map load coalesced when an obsolete load settles", async () => {
    const staleResponse = deferred<RouteResponse>();
    const currentResponse = deferred<RouteResponse>();
    let requests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-old",
                incarnation: "projection-old",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        requests += 1;
        if (requests === 1) return staleResponse.promise;
        if (requests === 2) return currentResponse.promise;
        return { status: 500, body: { error: "duplicate prompt-map load" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const stale = store.loadPromptMapTurns();
    await vi.waitFor(() => expect(requests).toBe(1));

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 5,
          viewId: "view-current",
          incarnation: "projection-current",
        },
      }),
    });
    const current = store.loadPromptMapTurns();
    await vi.waitFor(() => expect(requests).toBe(2));

    staleResponse.resolve({
      body: {
        sessionId: "s1",
        revision: 4,
        viewId: "view-old",
        incarnation: "projection-old",
        total: 1,
        start: 0,
        turns: [{ id: "old", ordinal: 0, snippet: "old", attachmentCount: 0 }],
      },
    });
    await stale;
    const coalesced = store.loadPromptMapTurns();
    expect(requests).toBe(2);

    currentResponse.resolve({
      body: {
        sessionId: "s1",
        revision: 5,
        viewId: "view-current",
        incarnation: "projection-current",
        total: 1,
        start: 0,
        turns: [
          {
            id: "current",
            ordinal: 0,
            snippet: "current",
            attachmentCount: 0,
          },
        ],
      },
    });
    await expect(Promise.all([current, coalesced])).resolves.toEqual([
      [
        {
          id: "current",
          ordinal: 0,
          snippet: "current",
          attachmentCount: 0,
        },
      ],
      [
        {
          id: "current",
          ordinal: 0,
          snippet: "current",
          attachmentCount: 0,
        },
      ],
    ]);
    expect(requests).toBe(2);
  });

  it("cancels an in-flight prompt-map seek when the branch view changes", async () => {
    const first = deferred<RouteResponse>();
    const { promise: firstStarted, resolve: firstRequested } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                messages: [
                  {
                    role: "user",
                    content: "latest",
                    timestamp: 10,
                    __inspireMessageId: "u2",
                    __inspireMessageIndex: 10,
                    __inspireUserTurnId: "u2",
                    __inspireUserTurnIndex: 2,
                  },
                ],
                hasOlder: true,
                olderCursor: "older-latest",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/user-turns")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            total: 3,
            start: 0,
            turns: [
              { id: "u0", ordinal: 0, snippet: "first", attachmentCount: 0 },
              { id: "u1", ordinal: 1, snippet: "second", attachmentCount: 0 },
              { id: "u2", ordinal: 2, snippet: "latest", attachmentCount: 0 },
            ],
          },
        };
      }
      if (url.includes("/api/transcript/user-turn?") && url.includes("id=u0")) {
        firstRequested();
        return first.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.loadPromptMapTurns();
    const obsolete = store.navigatePromptMapTurn(0);
    await firstStarted;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 5,
          viewId: "view-rewrite",
          incarnation: "projection-2",
          messages: [
            {
              role: "user",
              content: "rewritten",
              timestamp: 11,
              __inspireMessageId: "u-rewrite",
              __inspireMessageIndex: 0,
              __inspireUserTurnId: "u-rewrite",
              __inspireUserTurnIndex: 0,
            },
          ],
          hasOlder: false,
          olderCursor: null,
        },
      }),
    });
    first.resolve({
      body: {
        sessionId: "s1",
        revision: 4,
        viewId: "view-s1",
        incarnation: "projection-1",
        messages: [],
        hasOlder: false,
        olderCursor: null,
        targetMessageId: "u0",
        rangeStart: 0,
        rangeEnd: 0,
        hasMoreInTurn: false,
        continuationCursor: null,
      },
    });
    expect(await obsolete).toBe(false);
    expect(store.getState()).toMatchObject({
      transcriptViewId: "view-rewrite",
      promptMapNavigatingOrdinal: null,
      promptMapError: null,
    });
  });

  it("materializes a bounded activity tail before expanding the complete range", async () => {
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 5,
                    __inspireMessageId: "new-id",
                  },
                ],
                hasOlder: true,
                olderCursor: "older-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            appendFromRevision: 1,
            messages: [
              {
                role: "assistant",
                content: "response",
                timestamp: 1,
                __inspireMessageId: "response-id",
              },
            ],
            activityRanges: [
              {
                cursor: "activity-2",
                afterMessageId: "response-id",
                messageCount: 3,
                kinds: ["tool"],
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      if (url.startsWith("/api/transcript/activity")) {
        const cursor =
          new URL(url, "http://localhost").searchParams.get("cursor") ?? "";
        requested.push(cursor);
        return cursor === "activity-2"
          ? {
              body: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                appendFromRevision: 1,
                messages: [
                  {
                    role: "toolResult",
                    content: "second",
                    timestamp: 3,
                    __inspireMessageId: "activity-id-2",
                  },
                  {
                    role: "toolResult",
                    content: "third",
                    timestamp: 4,
                    __inspireMessageId: "activity-id-3",
                  },
                ],
                hasMore: true,
                cursor: "activity-1",
              },
            }
          : {
              body: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                appendFromRevision: 1,
                messages: [
                  {
                    role: "toolResult",
                    content: "first",
                    timestamp: 2,
                    __inspireMessageId: "activity-id-1",
                  },
                ],
                hasMore: false,
                cursor: null,
              },
            };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 5]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      { cursor: "activity-2", status: "idle" },
    ]);

    const beforeCommit = vi.fn();
    await store.materializeActivityRanges(["activity-2"], beforeCommit, "tail");
    expect(requested).toEqual(["activity-2"]);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 3, 4, 5]);
    expect(
      store
        .getState()
        .messages.slice(1, 3)
        .map((message) => message.__inspireActivityRangeCursor),
    ).toEqual(["activity-2", "activity-2"]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      {
        cursor: "activity-1",
        afterMessageId: "response-id",
        messageCount: 1,
        status: "idle",
      },
    ]);

    await store.materializeActivityRanges(["activity-1"], beforeCommit);
    expect(requested).toEqual(["activity-2", "activity-1"]);
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(store.getState().transcriptActivityRanges).toEqual([]);
  });

  it("leaves stale deferred activity retryable when its authoritative refresh fails", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                appendFromRevision: 1,
                messages: [
                  {
                    role: "assistant",
                    content: "response",
                    timestamp: 1,
                    __inspireMessageId: "response-id",
                  },
                ],
                activityRanges: [
                  {
                    cursor: "stale-activity",
                    afterMessageId: "response-id",
                    messageCount: 1,
                    kinds: ["tool"],
                  },
                ],
                hasOlder: false,
                olderCursor: null,
              },
            }),
          }),
        };
      if (url.startsWith("/api/transcript/activity"))
        return { status: 409, body: { error: "activity cursor is stale" } };
      if (url.startsWith("/api/snapshot"))
        return { status: 503, body: { error: "refresh unavailable" } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.materializeActivityRanges(["stale-activity"]);

    expect(store.getState().transcriptActivityRanges).toMatchObject([
      {
        cursor: "stale-activity",
        status: "error",
        error: "activity cursor is stale",
      },
    ]);
  });

  it("uses each returned cursor to load consecutive older pages", async () => {
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              pageMessages: [{ role: "user", content: "new", timestamp: 3 }],
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 3 }],
                hasOlder: true,
                olderCursor: "cursor-2",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        const cursor =
          new URL(url, "http://localhost").searchParams.get("cursor") ?? "";
        requested.push(cursor);
        return cursor === "cursor-2"
          ? {
              body: {
                sessionId: "s1",
                revision: 4,
                messages: [
                  { role: "assistant", content: "middle", timestamp: 2 },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }
          : {
              body: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "old", timestamp: 1 }],
                hasOlder: false,
                olderCursor: null,
              },
            };
      }
      return baseRoutes(url, init);
    });

    const { store } = await initStore();
    expect(await store.loadOlderMessages()).toBe(true);
    expect(await store.loadOlderMessages()).toBe(true);
    expect(requested).toEqual(["cursor-2", "cursor-1"]);
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2, 3]);
    expect(store.getState().hasOlderMessages).toBe(false);
  });

  it("keeps a failed automatic page local to the transcript and clears it on retry", async () => {
    let attempts = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        attempts += 1;
        if (attempts === 1)
          return { status: 503, body: { error: "temporarily unavailable" } };
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            messages: [{ role: "user", content: "old", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    expect(await store.loadOlderMessages()).toBe(false);
    expect(store.getState().olderMessagesError).toBe("temporarily unavailable");
    expect(store.getState().error).toBeNull();

    expect(await store.loadOlderMessages()).toBe(true);
    expect(store.getState().olderMessagesError).toBeNull();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2]);
  });

  it("discards a delayed older page from branch A after same-session switch to branch B", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-a",
                effectiveLeafId: "leaf-a",
                messages: [{ role: "user", content: "new A", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-a",
              },
              effectiveLeafId: "leaf-a",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            effectiveLeafId: "leaf-a",
            messages: [{ role: "user", content: "old A", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 4,
          viewId: "view-b",
          effectiveLeafId: "leaf-b",
          messages: [{ role: "assistant", content: "branch B", timestamp: 3 }],
          hasOlder: false,
          olderCursor: null,
        },
        effectiveLeafId: "leaf-b",
      }),
    });
    release();
    await loading;
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["branch B"],
    );
    expect(store.getState().transcriptViewId).toBe("view-b");
  });

  it("keeps an in-flight older load continuous across an append-lineage snapshot", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                appendFromRevision: 1,
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 5,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m3",
            messages: [
              {
                role: "user",
                content: "old",
                timestamp: 1,
                __inspireMessageId: "m1:0",
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;
    expect(store.getState().loadingOlderMessages).toBe(true);

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 5,
          viewId: "view-a",
          incarnation: "incarnation",
          appendFromRevision: 1,
          effectiveLeafId: "m3",
          messages: [
            {
              role: "user",
              content: "new",
              timestamp: 2,
              __inspireMessageId: "m2:0",
            },
            {
              role: "assistant",
              content: "append",
              timestamp: 3,
              __inspireMessageId: "m3:0",
            },
          ],
          hasOlder: true,
          olderCursor: "cursor-1",
        },
        effectiveLeafId: "m3",
      }),
    });
    expect(store.getState().loadingOlderMessages).toBe(true);

    release();
    await expect(loading).resolves.toBe(true);
    expect(store.getState().loadingOlderMessages).toBe(false);
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new", "append"],
    );
    expect(store.getState().hasOlderMessages).toBe(false);
  });

  it("discards an in-flight older page when the same view is rewritten", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                appendFromRevision: 1,
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m2",
            messages: [
              {
                role: "user",
                content: "stale older",
                timestamp: 1,
                __inspireMessageId: "m1:0",
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 5,
          viewId: "view-a",
          incarnation: "incarnation",
          appendFromRevision: 5,
          effectiveLeafId: "compact",
          messages: [
            {
              role: "user",
              content: "rewritten",
              timestamp: 9,
              __inspireMessageId: "compact:0",
            },
          ],
          hasOlder: false,
          olderCursor: null,
        },
        effectiveLeafId: "compact",
      }),
    });
    release();

    await expect(loading).resolves.toBe(false);
    expect(store.getState().loadingOlderMessages).toBe(false);
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["rewritten"],
    );
  });

  it("retains loaded older pages across same and append-lineage snapshots", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                appendFromRevision: 1,
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older"))
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m2",
            messages: [
              {
                role: "user",
                content: "old",
                timestamp: 1,
                __inspireMessageId: "m1:0",
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      if (url.startsWith("/api/snapshot"))
        return {
          body: activeSnapshot({
            transcriptPage: {
              sessionId: "s1",
              revision: 5,
              viewId: "view-a",
              incarnation: "incarnation",
              effectiveLeafId: "m3",
              appendFromRevision: 1,
              messages: [
                {
                  role: "user",
                  content: "new",
                  timestamp: 2,
                  __inspireMessageId: "m2:0",
                },
                {
                  role: "assistant",
                  content: "append",
                  timestamp: 3,
                  __inspireMessageId: "m3:0",
                },
              ],
              hasOlder: false,
              olderCursor: null,
            },
            effectiveLeafId: "m3",
          }),
        };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.loadOlderMessages();
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );

    // Worker warm-up can publish the same authoritative latest page after an
    // older page lands. It must not discard history from the identical view.
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 4,
          viewId: "view-a",
          incarnation: "incarnation",
          appendFromRevision: 1,
          effectiveLeafId: "m2",
          messages: [
            {
              role: "user",
              content: "new",
              timestamp: 2,
              __inspireMessageId: "m2:0",
            },
          ],
          hasOlder: true,
          olderCursor: "cursor-1",
        },
        effectiveLeafId: "m2",
      }),
    });
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );

    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 5,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(store.getState().transcriptRevision).toBe(5));
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new", "append"],
    );
    expect(store.getState().hasOlderMessages).toBe(false);
  });

  it("does not clear a projection-owned alert when an older page loads successfully", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              projectionHealth: {
                status: "error",
                message: "projection damaged",
              },
              projectionConflict: {
                kind: "projection-failure",
                message: "projection conflict",
                revision: 4,
                incidentId: "incident-projection",
              },
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                incarnation: "inc",
                appendFromRevision: 4,
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "older",
              },
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older"))
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            incarnation: "inc",
            appendFromRevision: 4,
            messages: [
              {
                role: "user",
                content: "old",
                timestamp: 1,
                __inspireMessageId: "m1:0",
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().error).toBe("projection conflict");
    await store.loadOlderMessages();
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );
    expect(store.getState().projectionError).toBe("projection conflict");
    expect(store.getState().error).toBe("projection conflict");
  });

  it("rejects a stale returned revision without mixing pages", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              pageMessages: [{ role: "user", content: "new", timestamp: 2 }],
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        return {
          body: {
            sessionId: "s1",
            revision: 3,
            messages: [{ role: "user", content: "stale", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(store.getState().messages).toEqual([
      { role: "user", content: "new", timestamp: 2 },
    ]);
    expect(store.getState().transcriptRevision).toBe(4);
    expect(store.getState().loadingOlderMessages).toBe(false);
  });

  it("resyncs rather than accepting a server-rejected stale cursor", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                sessionId: "s1",
                revision: 4,
                messages: [],
                hasOlder: true,
                olderCursor: "old",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older"))
        return { status: 409, body: { error: "stale" } };
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({
            transcriptPage: {
              sessionId: "s1",
              revision: 5,
              messages: [{ role: "assistant", content: "fresh", timestamp: 5 }],
              hasOlder: false,
              olderCursor: null,
            },
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(snapshotCalls).toBe(1);
    expect(store.getState().transcriptRevision).toBe(5);
    expect(store.getState().messages[0]).toMatchObject({ content: "fresh" });
  });
});

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

describe("session switching guard", () => {
  beforeEach(() => installFakeWebSocket());

  it("clears the pending state and surfaces the error when the open fails", async () => {
    installFetch(baseRoutes);
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          return new Response(
            JSON.stringify({ error: "session is owned by another Pi process" }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 404,
        });
      }),
    );

    await store.openSession("s9");
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().sessionId).toBe("s1"); // active session unchanged
    expect(store.getState().error).toBeNull();
    expect(store.getState().sessionActionError).toBe(
      "session is owned by another Pi process",
    );

    // a later selection is not blocked by the failed attempt
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          return new Response(
            JSON.stringify(activeSnapshot({ sessionId: "s3" })),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 404,
        });
      }),
    );
    await store.openSession("s3");
    expect(store.getState().sessionId).toBe("s3");
    expect(store.getState().error).toBeNull();
  });
});

describe("navigation curation", () => {
  beforeEach(() => installFakeWebSocket());

  const curationRoutes = (
    patchBehavior: "ok" | "fail",
    onPatch?: (patch: Record<string, unknown>) => void,
  ): RouteHandler => {
    return (url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        onPatch?.(patch);
        if (patchBehavior === "fail")
          return { status: 500, body: { error: "preference write rejected" } };
        return { body: { ...bootstrapPayload().preferences, ...patch } };
      }
      if (url.startsWith("/api/sessions")) {
        return {
          body: {
            sessions: [
              {
                id: "s7",
                cwd: "/demo",
                project: "demo",
                title: "Pin target",
                created: "2026-07-20T10:00:00Z",
                modified: "2026-07-21T10:00:00Z",
                messageCount: 2,
              },
            ],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    };
  };

  it("retains an off-page curated row until restore is confirmed, then prunes it without a list reload", async () => {
    let listRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenSessionIds: ["off-page"],
            },
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-id")) {
        return {
          body: {
            sessions: [
              sessionSummary({ id: "off-page", cwd: "/work/archived" }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "off-page",
      ]),
    );

    store.toggleSessionHidden("off-page");
    expect(store.getState().sessions.map((session) => session.id)).toContain(
      "off-page",
    );
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
      ]),
    );
    expect(listRequests).toBe(1);
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListHydrating: false,
      sessionListNextOffset: 1,
      sessionListTotal: 2,
    });
  });

  it("does not revive rows from a catalog refresh that captured older curation", async () => {
    let folderRequests = 0;
    const { promise: refreshHydrationGate, resolve: releaseRefreshHydration } =
      deferred<void>();
    const {
      promise: refreshHydrationRequest,
      resolve: refreshHydrationStarted,
    } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenProjectCwds: ["/work/demo"],
            },
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/refresh")) {
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderRequests += 1;
        if (folderRequests === 2) {
          refreshHydrationStarted();
          await refreshHydrationGate;
        }
        return {
          body: {
            sessions: [sessionSummary({ id: "off-page", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "off-page",
      ]),
    );

    const refresh = store.refreshSessions();
    await refreshHydrationRequest;
    store.toggleProjectHidden("/work/demo");
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
      ]),
    );

    releaseRefreshHydration();
    await refresh;
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "recent",
    ]);
  });

  it("hydrates a newly curated folder without resetting or foregrounding the chronological list", async () => {
    let listRequests = 0;
    const { promise: folderGate, resolve: releaseFolder } = deferred<void>();
    const { promise: folderRequest, resolve: folderStarted } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderStarted();
        await folderGate;
        return {
          body: {
            sessions: [sessionSummary({ id: "folder-old", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent", cwd: "/work/other" })],
            total: 8,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(false),
    );

    store.toggleProjectHidden("/work/demo");
    await folderRequest;
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListHydrating: true,
      sessionListOperation: "curation",
      sessionListNextOffset: 1,
      sessionListTotal: 8,
    });
    expect(listRequests).toBe(1);

    releaseFolder();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "folder-old",
      ]),
    );
    expect(store.getState()).toMatchObject({
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListNextOffset: 1,
      sessionListTotal: 8,
    });
    expect(listRequests).toBe(1);
  });

  it("hydrates confirmed curation restored after a newer queued removal is refused", async () => {
    let listRequests = 0;
    let folderRequests = 0;
    let preferenceWrites = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        preferenceWrites += 1;
        if (preferenceWrites === 2) {
          return { status: 500, body: { error: "removal rejected" } };
        }
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "folder-old", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(false),
    );

    store.toggleProjectHidden("/work/demo");
    store.toggleProjectHidden("/work/demo");
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);

    await vi.waitFor(() =>
      expect(store.getState().prefs.hiddenProjectCwds).toEqual(["/work/demo"]),
    );
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "folder-old",
      ]),
    );
    expect(folderRequests).toBeGreaterThanOrEqual(1);
    expect(listRequests).toBe(1);
  });

  it("rolls a refused curation write back and reports it", async () => {
    installFetch(curationRoutes("fail"));
    const { store } = await initStore();

    store.toggleSessionPin("s7");
    expect(store.getState().prefs.pinnedSessionIds).toEqual(["s7"]);

    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .notices.some(
            (notice) =>
              notice.kind === "warning" &&
              notice.text === "preference write rejected",
          ),
      ).toBe(true),
    );
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
  });

  it("keeps a pending preference visible across transport replacement and rolls back to the new host baseline", async () => {
    const pendingPatch = deferred<RouteResponse>();
    const { promise: started, resolve: patchStarted } = deferred<void>();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        const token = new Headers(init.headers).get("authorization");
        return {
          body: bootstrapPayload({
            preferences: {
              ...DEFAULT_PREFS,
              theme: token === "Bearer fresh" ? "light" : "system",
            },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        patchStarted();
        return pendingPatch.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    await started;
    await store.init("fresh");
    expect(store.getState().prefs.theme).toBe("dark");

    pendingPatch.resolve({
      status: 500,
      body: { error: "preference write rejected" },
    });
    await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("light"));
  });

  it("keeps the newest owner when a refused preference write has the same value", async () => {
    let writes = 0;
    const patches: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        writes += 1;
        patches.push(jsonBody(init));
        if (writes === 1) {
          return { status: 500, body: { error: "preference write rejected" } };
        }
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    store.setTheme("light");
    store.setTheme("dark");
    await vi.waitFor(() => expect(patches).toHaveLength(3));

    expect(store.getState().prefs.theme).toBe("dark");
  });

  it("fetches pinned and hidden sessions missing from the first page", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              pinnedSessionIds: ["s-pinned"],
              hiddenSessionIds: ["s-hidden"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-id")) {
        const body = jsonBody(init) as { ids: string[] };
        // Hidden sessions hydrate too: the Hidden group is what makes hiding
        // reversible, so its rows cannot depend on the first catalog page.
        expect(body.ids).toEqual(["s-pinned", "s-hidden", "s1"]);
        return {
          body: {
            sessions: body.ids.map((id) => ({
              id,
              cwd: "/elsewhere",
              project: "elsewhere",
              title: `Off-page ${id}`,
              created: "2026-07-19T10:00:00Z",
              modified: "2026-07-19T11:00:00Z",
              messageCount: 5,
            })),
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => {
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "s-pinned",
        "s-hidden",
        "s1",
      ]);
    });
  });

  it("fetches a pinned folder whose sessions all fall outside the first page", async () => {
    let byCwdRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              pinnedProjectCwds: ["/work/pinned-folder"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        byCwdRequests += 1;
        expect(jsonBody(init)).toEqual({ cwds: ["/work/pinned-folder"] });
        // A folder pin claims the whole folder, so its rows arrive by cwd
        // rather than depending on which of them are recent enough to page in.
        return {
          body: {
            sessions: ["old-a", "old-b"].map((id) => ({
              id,
              cwd: "/work/pinned-folder",
              project: "pinned-folder",
              title: `Archived ${id}`,
              created: "2026-01-02T10:00:00Z",
              modified: "2026-01-02T11:00:00Z",
              messageCount: 3,
            })),
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        // The newest page holds nothing from that folder at all.
        return {
          body: {
            sessions: [sessionSummary({ id: "recent", cwd: "/work/other" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => {
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "old-a",
        "old-b",
      ]);
    });
    expect(byCwdRequests).toBe(1);
  });

  it("fetches a hidden folder by cwd so restoring it never depends on the first page", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenProjectCwds: ["/work/hidden-folder"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        expect(jsonBody(init)).toEqual({ cwds: ["/work/hidden-folder"] });
        return {
          body: {
            sessions: [
              sessionSummary({ id: "hidden-old", cwd: "/work/hidden-folder" }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "hidden-old",
      ]),
    );
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([
      "/work/hidden-folder",
    ]);
  });

  it("restores the last confirmed value when two writes fail in a row", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return { status: 500, body: { error: "preference write rejected" } };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().prefs.theme).toBe("system");

    store.setTheme("dark");
    store.setTheme("light");

    // Neither write reached disk, so the surviving value has to be the one the
    // host still holds — not "dark", which was only ever a local optimism.
    await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("system"));
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" &&
            notice.text === "preference write rejected",
        ),
    ).toBe(true);
  });

  it("adopts untouched authoritative fields as the next rollback baseline", async () => {
    let writes = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        writes += 1;
        if (writes === 2)
          return { status: 500, body: { error: "preference write rejected" } };
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
            palette: "teal",
          },
        };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    await vi.waitFor(() => expect(store.getState().prefs.palette).toBe("teal"));

    store.setPalette("amber");
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .notices.some(
            (notice) => notice.text === "preference write rejected",
          ),
      ).toBe(true),
    );
    expect(store.getState().prefs.palette).toBe("teal");
  });
});

describe("resource previews", () => {
  const nativeUrl = globalThis.URL;

  beforeEach(() => installFakeWebSocket());
  afterEach(() => {
    // URL is the platform parser used by later tests; object-URL stubs must
    // not replace its constructor beyond the one preview test that owns them.
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      writable: true,
      value: nativeUrl,
    });
  });

  it("makes sandboxed HTML inert before creating its blob document", () => {
    const html = injectHtmlPreviewCsp(
      '<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script></body></html>',
    );
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<base");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });

  it("injects the preview CSP into the real head, not a commented-out one", () => {
    const html = injectHtmlPreviewCsp(
      '<!-- <head> --><img src="https://attacker.invalid/pixel">',
    );
    const reparsed = new DOMParser().parseFromString(html, "text/html");
    const meta = reparsed.head.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    expect(meta?.getAttribute("content")).toContain("default-src 'none'");
    // The decoy comment must not have swallowed the policy.
    expect(reparsed.head.innerHTML).not.toContain("<!--");
  });

  function resourceRoutes(): RouteHandler {
    return (url, init) => {
      if (url.startsWith("/api/resources/list")) {
        expect(jsonBody(init)).toEqual({ sessionId: "s1" });
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            offset: 0,
            total: 1,
            nextCursor: null,
            resources: [
              {
                key: "file:notes/result.md",
                reference: "notes/result.md",
                label: "notes/result.md",
                source: "link",
              },
            ],
          },
        };
      }
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference.includes("missing")
                ? {
                    reference,
                    availability: "missing",
                    message: "The referenced file was not found",
                  }
                : reference.includes("outside")
                  ? {
                      reference,
                      availability: "unavailable",
                      message: "The file is outside this session",
                    }
                  : { reference, availability: "available" },
            ),
          },
        };
      }
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        if (body.reference.includes("missing")) {
          return {
            status: 404,
            body: { error: "The referenced file was not found" },
          };
        }
        return {
          body: {
            id: "r1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference.split("/").pop(),
            mimeType: "text/markdown",
            size: 12, // matches the stubbed "# Notes body" content exactly
            kind: "markdown",
          },
        };
      }
      return baseRoutes(url, init);
    };
  }

  function stubContent(
    text: string,
    headers: Record<string, string> = {},
  ): void {
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/") && url.includes("/content")) {
          return new Response(text, {
            status: 200,
            headers: { "Content-Type": "text/markdown", ...headers },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
  }

  it("preflights every loaded reference in bounded batches without selecting or loading content", async () => {
    const batches: string[][] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        batches.push(body.references);
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference.includes("missing")
                ? {
                    reference,
                    availability: "missing",
                    message: "The referenced file was not found",
                  }
                : reference.includes("outside")
                  ? {
                      reference,
                      availability: "unavailable",
                      message: "The file is outside this session",
                    }
                  : { reference, availability: "available" },
            ),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();
    const references = Array.from(
      { length: 18 },
      (_, index) => `file-${index}.md`,
    );
    references[16] = "missing/file.md";
    references[17] = "outside/file.md";

    await store.probeResources(references);
    await store.probeResources([...references, "newly-loaded.md"]);
    await store.probeResources([...references, "newly-loaded.md"]);
    expect(batches.map((batch) => batch.length)).toEqual([16, 2, 1]);
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().resourceAvailability).toMatchObject({
      "missing/file.md": { availability: "missing" },
      "outside/file.md": { availability: "unavailable" },
    });
    expect(store.getState().resourceAvailability["file-0.md"]).toBeUndefined();
  });

  it("keeps probe transport failures visibly unknown and retryable", async () => {
    let fail = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        if (fail) return { status: 503, body: { error: "probe unavailable" } };
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();

    await store.probeResources(["retry.md"]);
    expect(store.getState().resourceAvailability["retry.md"]).toMatchObject({
      availability: "unknown",
    });
    fail = false;
    await store.probeResources(["retry.md"]);
    expect(store.getState().resourceAvailability["retry.md"]).toBeUndefined();
  });

  it("preserves successful batches when a later availability batch fails", async () => {
    const requests: string[][] = [];
    let failSecondBatch = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        requests.push(body.references);
        if (failSecondBatch && body.references[0] === "file-16.md") {
          return { status: 503, body: { error: "second batch unavailable" } };
        }
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference === "file-0.md"
                ? { reference, availability: "missing", message: "not found" }
                : { reference, availability: "available" },
            ),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();
    const references = Array.from(
      { length: 32 },
      (_, index) => `file-${index}.md`,
    );

    await store.probeResources(references);
    expect(requests.map((batch) => batch.length)).toEqual([16, 16]);
    expect(store.getState().resourceAvailability["file-0.md"]).toMatchObject({
      availability: "missing",
    });
    expect(store.getState().resourceAvailability["file-16.md"]).toMatchObject({
      availability: "unknown",
    });

    failSecondBatch = false;
    await store.probeResources(references);
    expect(requests.map((batch) => batch.length)).toEqual([16, 16, 16]);
    expect(requests[2]).toEqual(references.slice(16));
    expect(store.getState().resourceAvailability["file-0.md"]).toMatchObject({
      availability: "missing",
    });
    expect(store.getState().resourceAvailability["file-16.md"]).toBeUndefined();
  });

  it("explicitly invalidates and re-probes same-revision filesystem standing", async () => {
    let missing = true;
    let probeRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        probeRequests += 1;
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: missing ? "missing" : "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();

    await store.probeResources(["changing.md"]);
    expect(store.getState().resourceAvailability["changing.md"]).toMatchObject({
      availability: "missing",
    });
    missing = false;
    await store.probeResources(["changing.md"]);
    expect(probeRequests).toBe(1);

    store.cancelResourceProbes(true);
    expect(
      store.getState().resourceAvailability["changing.md"],
    ).toBeUndefined();
    await store.probeResources(["changing.md"]);
    expect(probeRequests).toBe(2);
    expect(
      store.getState().resourceAvailability["changing.md"],
    ).toBeUndefined();
  });

  it("discards probe standing from an obsolete transcript revision", async () => {
    let responseRevision = 1;
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: responseRevision,
            results: body.references.map((reference) => ({
              reference,
              availability: "missing",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store, socket } = await initStore();
    const stale = store.probeResources(["missing/file.md"]);
    await requested;
    const currentPage = activeSnapshot().active!.transcriptPage!;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ transcriptPage: { ...currentPage, revision: 2 } }),
    });
    release();
    await stale;
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toBeUndefined();

    responseRevision = 2;
    await store.probeResources(["missing/file.md"]);
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({ availability: "missing" });
  });

  it("ignores a superseded probe 401 after a fresh pairing succeeds", async () => {
    const oldProbe = deferred<RouteResponse>();
    const { promise: probeStarted, resolve: markProbeStarted } =
      deferred<void>();
    let probeRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        const token = requestToken(init);
        return {
          body: bootstrapPayload({
            version: `host-${token}`,
            snapshot: activeSnapshot(),
          }),
        };
      }
      if (url.startsWith("/api/resources/probe")) {
        probeRequests += 1;
        if (probeRequests === 1) {
          markProbeStarted();
          return oldProbe.promise;
        }
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const store = new AppStore();
    await store.init("old-token");
    FakeWebSocket.instances.at(-1)!.open();

    const oldRequest = store.probeResources(["stale.md"]);
    await probeStarted;
    await store.init("fresh-token");
    const freshSocket = FakeWebSocket.instances.at(-1)!;
    freshSocket.open();

    oldProbe.resolve({ status: 401, body: { error: "old token expired" } });
    await oldRequest;

    expect(store.getState()).toMatchObject({
      version: "host-fresh-token",
      sessionId: "s1",
      needsToken: false,
      connection: "open",
    });
    expect(freshSocket.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=s1`,
    );
    expect(store.getState().resourceAvailability).toEqual({});
  });

  it("loads a complete notebook within the bounded document-preview range", async () => {
    let range: string | null = null;
    const notebook = JSON.stringify({
      cells: [{ cell_type: "markdown", source: ["# Result"] }],
      metadata: {},
      nbformat: 4,
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "notebook",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "analysis.ipynb",
            workspacePath: "analysis.ipynb",
            name: "analysis.ipynb",
            mimeType: "application/x-ipynb+json",
            size: notebook.length,
            kind: "notebook",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/notebook/content")) {
          range = new Headers(init?.headers).get("Range");
          return new Response(notebook, {
            headers: { "Content-Type": "application/x-ipynb+json" },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
    const { store } = await initStore();

    await store.openResource("analysis.ipynb");

    expect(range).toBe(`bytes=0-${NOTEBOOK_PREVIEW_BYTES - 1}`);
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: false,
      text: notebook,
      descriptor: { kind: "notebook" },
    });
  });

  it("clears conversation-derived resource selection on a same-session branch-view boundary", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store, socket } = await initStore();
    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({ status: "ready" });

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 1,
          viewId: "view-branch-b",
          effectiveLeafId: "branch-b",
          messages: [],
          hasOlder: false,
          olderCursor: null,
        },
        effectiveLeafId: "branch-b",
      }),
    });

    expect(store.getState().sessionId).toBe("s1");
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
  });

  it("uses the transfer total for grown and shrunk files instead of resolve metadata", async () => {
    const resolveRoutes = resourceRoutes();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        return {
          body: {
            id: body.reference,
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference,
            mimeType: "text/markdown",
            size: 12,
            kind: "markdown",
          },
        };
      }
      return resolveRoutes(url, init);
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/grown.md/content")) {
          return new Response("grown", {
            status: 206,
            headers: {
              "Content-Range": "bytes 0-4/20",
              "Content-Type": "text/markdown",
            },
          });
        }
        if (url.includes("/api/resources/shrunk.md/content")) {
          return new Response("tiny", {
            status: 206,
            headers: {
              "Content-Range": "bytes 0-3/4",
              "Content-Type": "text/markdown",
            },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
    const { store } = await initStore();

    await store.openResource("grown.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: true,
      descriptor: { size: 20 },
    });

    await store.openResource("shrunk.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: false,
      descriptor: { size: 4 },
    });
  });

  it("withholds oversized media without starting a content transfer", async () => {
    let contentRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "large-image",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "large.png",
            name: "large.png",
            mimeType: "image/png",
            size: MAX_MEDIA_PREVIEW_BYTES + 1,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/") && url.includes("/content")) {
        contentRequests += 1;
        return { body: "should not load" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.openResource("large.png");
    expect(contentRequests).toBe(0);
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      contentUnavailable: "too-large",
    });
  });

  it("range-bounds media and aborts an obsolete transfer", async () => {
    const { promise: started, resolve: firstTransferStarted } =
      deferred<void>();
    let firstSignal: AbortSignal | undefined;
    let secondRange: string | null = null;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:second"),
      revokeObjectURL: vi.fn(),
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        return {
          body: {
            id: body.reference.startsWith("first") ? "first" : "second",
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference,
            mimeType: "image/png",
            size: 12,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/first/content")) {
        firstSignal = init.signal ?? undefined;
        firstTransferStarted();
        return new Promise<never>((_resolve, reject) => {
          firstSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.includes("/api/resources/second/content")) {
        secondRange = new Headers(init.headers).get("Range");
        return { body: "second image" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const first = store.openResource("first.png");
    await started;
    const second = store.openResource("second.png");
    await Promise.all([first, second]);

    expect(firstSignal?.aborted).toBe(true);
    expect(secondRange).toBe(`bytes=0-${MAX_MEDIA_PREVIEW_BYTES}`);
    expect(store.getState().selectedResourceReference).toBe("second.png");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      objectUrl: "blob:second",
    });
  });

  it("loads an embedded transcript image only inside its owning branch view", async () => {
    let range: string | null = null;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        range = new Headers(init.headers).get("Range");
        return { body: "png" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().transcriptViewId).toBe("view-s1");

    const blob = await store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    expect(await blob.text()).toContain("png");
    expect(range).toBe(`bytes=0-${MAX_MEDIA_PREVIEW_BYTES}`);
    await expect(
      store.loadEmbeddedImage(
        "s1",
        "obsolete",
        "obsolete\u0000projection-1",
        "pi-embedded://4/0",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects embedded-image bytes from a replaced projection incarnation", async () => {
    const oldContent = deferred<RouteResponse>();
    const { promise: started, resolve: contentStarted } = deferred<void>();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        contentStarted();
        return oldContent.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const loading = store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    await started;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: { incarnation: "projection-2" },
      }),
    });
    oldContent.resolve({ body: "old" });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores an obsolete embedded-image authorization failure after transport replacement", async () => {
    const oldContent = deferred<RouteResponse>();
    const { promise: started, resolve: contentStarted } = deferred<void>();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        contentStarted();
        return oldContent.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const loading = store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    await started;
    await store.init("fresh");
    oldContent.resolve({ status: 401, body: { error: "expired token" } });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getState().needsToken).toBe(false);
  });

  it("aborts a pending preview when the session changes", async () => {
    const { promise: started, resolve: transferStarted } = deferred<void>();
    let signal: AbortSignal | undefined;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "owned-by-s1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "owned.png",
            name: "owned.png",
            mimeType: "image/png",
            size: 12,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/owned-by-s1/content")) {
        signal = init.signal ?? undefined;
        transferStarted();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const opening = store.openResource("owned.png");
    await started;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Other" }),
    });
    await opening;

    expect(signal?.aborted).toBe(true);
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().selectedResourceReference).toBeNull();
  });

  it("surfaces a truthful error state when the host rejects the reference", async () => {
    installFetch(resourceRoutes());
    const { store } = await initStore();

    await store.openResource("missing/file.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "error",
      message: "The referenced file was not found",
    });
    // The list stops presenting an unverified mention as an ordinary file…
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({
      reference: "missing/file.md",
      availability: "missing",
    });

    // …but a reference that resolved and then failed to transfer keeps its
    // standing: the file exists, the bytes did not arrive.
    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({ status: "error" });
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({ availability: "missing" });

    // A reference that resolves after all clears its mark.
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "r2",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "missing/file.md",
            name: "file.md",
            mimeType: "text/markdown",
            size: 12,
            kind: "markdown",
          },
        };
      }
      return baseRoutes(url, init);
    });
    stubContent("# Notes body");
    await store.openResource("missing/file.md");
    expect(store.getState().resourceAvailability).toEqual({});
  });

  it("offers the host's candidates instead of guessing an ambiguous bare name", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          status: 409,
          body: {
            error: '"notes.md" names 2 files in this workspace',
            matches: ["a/notes.md", "b/notes.md"],
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.openResource("notes.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ambiguous",
      reference: "notes.md",
      matches: ["a/notes.md", "b/notes.md"],
    });
    // An unanswered choice is not missing, but the row can advertise that it
    // needs a location choice before previewing.
    expect(store.getState().resourceAvailability["notes.md"]).toMatchObject({
      availability: "ambiguous",
      matches: ["a/notes.md", "b/notes.md"],
    });
  });

  it("clears the selection and revokes the object URL when the session changes", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const url = `blob:preview-${created.length}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "r1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "chart.png",
            name: "chart.png",
            mimeType: "image/png",
            size: 10,
            kind: "image",
          },
        };
      }
      return baseRoutes(url, init);
    });
    stubContent("fake-image-bytes");
    const { store, socket } = await initStore();

    await store.openResource("chart.png");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      objectUrl: "blob:preview-0",
    });
    expect(created).toHaveLength(1);

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Other" }),
    });
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
    expect(revoked).toEqual(["blob:preview-0"]);
  });

  it("clears a selected resource when the same view projection is replaced", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store, socket } = await initStore();

    await store.openResource("notes/result.md");
    expect(store.getState()).toMatchObject({
      fileBrowserView: "preview",
      selectedResourceReference: "notes/result.md",
      resourcePreview: { status: "ready" },
    });

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 2,
          appendFromRevision: 2,
          incarnation: "projection-2",
        },
      }),
    });

    expect(store.getState()).toMatchObject({
      fileBrowserView: "browse",
      selectedResourceReference: null,
      resourcePreview: null,
      resourceAvailability: {},
      resourceWorkspacePaths: {},
    });
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

describe("async completion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("a delayed rename response cannot retitle a different session", async () => {
    const { promise: renameGate, resolve: releaseRename } = deferred<void>();
    let renameBody: Record<string, unknown> | null = null;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/rename")) {
        renameBody = jsonBody(init);
        await renameGate;
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const renaming = store.renameSession("s1", "Renamed A");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
    });
    releaseRename();
    await expect(renaming).resolves.toBe(true);
    expect(renameBody).toEqual({ sessionId: "s1", name: "Renamed A" });
    // The rename belonged to s1; the visible title of s2 stays truthful.
    expect(store.getState().sessionName).toBe("Session B");
  });
});

describe("selection race ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("an authoritative push invalidates an in-flight open response", async () => {
    const { promise: openGate, resolve: releaseOpen } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/open")) {
        await openGate;
        return { body: activeSnapshot({ sessionId: "s-A", sessionName: "A" }) };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const opening = store.openSession("s-A");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s-B", sessionName: "B" }),
    });
    expect(store.getState().sessionId).toBe("s-B");
    releaseOpen();
    await opening;
    expect(store.getState().sessionId).toBe("s-B");
  });

  it("a failed thinking-level change does not roll back over another session", async () => {
    const { promise: gate, resolve: releaseThinking } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/control/thinking")) {
        await gate;
        return { status: 500, body: { error: "unsupported level" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const changing = store.setThinkingLevel("high"); // optimistic on s1, gated
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "s2",
        sessionName: "B",
        thinkingLevel: "low",
      }),
    });
    expect(store.getState().thinkingLevel).toBe("low");

    releaseThinking();
    await changing;
    // The rollback belonged to s1; s2's visible level stays truthful.
    expect(store.getState().thinkingLevel).toBe("low");
  });
});

describe("session deletion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("removes a deleted hidden session from curation, pagination, status, and its draft", async () => {
    const active = activeSnapshot({ sessionId: "s1", sessionName: "Active" });
    active.sessionStatuses.s2 = { runState: "idle", indicator: "completed" };
    const rows = [
      sessionSummary({ id: "s1", title: "Active" }),
      sessionSummary({ id: "s2", title: "Archived" }),
    ];
    let deleted = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: active,
            preferences: {
              ...DEFAULT_PREFS,
              pinnedSessionIds: ["s2"],
              hiddenSessionIds: ["s2"],
            },
          }),
        };
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleted = true;
        return {
          body: {
            sessionId: "s2",
            disposition: "trashed",
            preferences: {
              ...DEFAULT_PREFS,
              pinnedSessionIds: [],
              hiddenSessionIds: [],
            },
          },
        };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: deleted ? [] : [rows[1]] } };
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "s1",
        "s2",
      ]),
    );
    setSessionDraft("s2", "not for another session");

    await expect(store.deleteSession("s2")).resolves.toBe("trashed");
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "s1",
    ]);
    expect(store.getState().sessionStatuses).not.toHaveProperty("s2");
    expect(store.getState().prefs).toMatchObject({
      pinnedSessionIds: [],
      hiddenSessionIds: [],
    });
    expect(sessionDraft("s2")).toBe("");
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Session moved to Trash",
    );
  });

  it("fences an optimistic Hide write before sending the destructive request", async () => {
    const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
    const { promise: patchGate, resolve: releasePatch } = deferred<void>();
    let deleteCalled = false;
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        await patchGate;
        return { body: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] } };
      }
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleteCalled = true;
        deleted = true;
        return {
          body: {
            sessionId: "s2",
            disposition: "trashed",
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: [] },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));

    store.toggleSessionHidden("s2");
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]);
    const deleting = store.deleteSession("s2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteCalled).toBe(false);
    releasePatch();
    await expect(deleting).resolves.toBe("trashed");
    expect(deleteCalled).toBe(true);
  });

  it("preserves a newer setting when deletion returns an older preference snapshot", async () => {
    const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
    const { promise: deleteGate, resolve: releaseDelete } = deferred<void>();
    const { promise: started, resolve: deleteStarted } = deferred<void>();
    const patches: Record<string, unknown>[] = [];
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        return { body: { ...DEFAULT_PREFS, ...patch } };
      }
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleteStarted();
        await deleteGate;
        deleted = true;
        return {
          body: {
            sessionId: "s2",
            disposition: "trashed",
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: [] },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));

    const deleting = store.deleteSession("s2");
    await started;
    store.setTheme("dark");
    store.toggleSessionPin("s1");
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
    await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
    expect(patches.some((patch) => "pinnedSessionIds" in patch)).toBe(false);
    releaseDelete();

    await expect(deleting).resolves.toBe("trashed");
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      hiddenSessionIds: [],
    });
  });

  it("preserves a newer setting when clearing Hidden returns an older preference snapshot", async () => {
    const row = sessionSummary({ id: "s2" });
    const { promise: clearGate, resolve: releaseClear } = deferred<void>();
    const { promise: started, resolve: clearStarted } = deferred<void>();
    const patches: Record<string, unknown>[] = [];
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        return { body: { ...DEFAULT_PREFS, ...patch } };
      }
      if (url.startsWith("/api/sessions/clear-hidden")) {
        clearStarted();
        await clearGate;
        deleted = true;
        return {
          body: {
            deleted: [{ sessionId: "s2", disposition: "trashed" }],
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: [] },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? [] : [row];
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(1));

    const clearing = store.clearHiddenSessions(["s2"]);
    await started;
    store.setTheme("dark");
    await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
    releaseClear();

    await expect(clearing).resolves.toMatchObject({
      deleted: [{ sessionId: "s2", disposition: "trashed" }],
    });
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      hiddenSessionIds: [],
    });
  });

  it("keeps local session state intact when deletion is refused", async () => {
    const row = sessionSummary({ id: "s2", title: "Archived" });
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        return { status: 409, body: { error: "Session is still running" } };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [row] } };
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [row], total: 1, offset: 0, limit: 40 } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(1));
    setSessionDraft("s2", "keep me");

    await expect(store.deleteSession("s2")).resolves.toBeNull();
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]);
    expect(sessionDraft("s2")).toBe("keep me");
    expect(store.getState().error).toBeNull();
    expect(store.getState().sessionDeleteError).toBe(
      "Session is still running",
    );
  });
});
