// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
import {
  AppStore,
  injectHtmlPreviewCsp,
  MAX_MEDIA_PREVIEW_BYTES,
} from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
  type RouteHandler,
  type RouteResponse,
} from "./helpers";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions"))
    return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

function deferredResponse(): {
  promise: Promise<RouteResponse>;
  resolve(response: RouteResponse): void;
} {
  let resolve!: (response: RouteResponse) => void;
  const promise = new Promise<RouteResponse>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requestToken(init: RequestInit): string | null {
  const authorization = (init.headers as Record<string, string> | undefined)
    ?.Authorization;
  return authorization?.replace(/^Bearer /u, "") ?? null;
}

function installDeferredBootstrapRoutes(...tokens: string[]) {
  const responses = new Map(
    tokens.map((token) => [token, deferredResponse()] as const),
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
  socket.open();
  return { store, socket };
}

describe("websocket lifecycle", () => {
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
    expect(socket.url).toBe("ws://localhost:3000/events");
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
    expect(FakeWebSocket.instances[0]?.url).toContain("token=new");
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
    expect(FakeWebSocket.instances[0]?.url).toContain("token=fresh");
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

  it("distinguishes an unreachable host from a host that requires pairing", async () => {
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
        connectionProblem: { kind: "host-unreachable" },
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

  it("ignores unknown wire events without notifying listeners", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    socket.emit({ type: "future_wire_event", data: { anything: true } });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
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
          message: "external writer conflict",
          revision: 3,
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
    snapshot.pendingQueues = {
      steering: ["correct the current answer"],
      followUp: ["then add tests", "then summarize"],
    };
    snapshot.extensionDisplays = [
      {
        id: "setWidget:plan",
        method: "setWidget",
        attribution: "plan.ts · plan",
        payload: { widgetLines: ["step"] },
      },
    ];
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
    expect(store.getState().queue).toEqual({
      steering: ["correct the current answer"],
      followUp: ["then add tests", "then summarize"],
    });
    expect(store.getState().extensionDisplays).toHaveLength(1);
    expect(store.getState().activeAssistantMessageKey).toBe("persisted:a1:0");

    if (snapshot.active) snapshot.active.activeAssistantMessageKey = null;
    snapshot.pendingExtensionUiRequests = [];
    snapshot.pendingQueues = { steering: [], followUp: [] };
    snapshot.extensionDisplays = [];
    socket.emit({ type: "snapshot", data: snapshot });
    expect(store.getState().extensionUiRequests).toEqual([]);
    expect(store.getState().queue).toEqual({ steering: [], followUp: [] });
    expect(store.getState().extensionDisplays).toEqual([]);
    expect(store.getState().activeAssistantMessageKey).toBeNull();
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

  it("keeps equal-timestamp ordinary live messages distinct when host lifecycle IDs differ", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    for (const [id, content] of [
      ["live-1", "first"],
      ["live-2", "second"],
    ] as const) {
      socket.emit({
        type: "message_start",
        sessionId: "s1",
        message: {
          role: "assistant",
          content,
          timestamp: 2,
          __inspireLiveId: id,
        },
      });
      socket.emit({
        type: "message_end",
        sessionId: "s1",
        message: {
          role: "assistant",
          content,
          timestamp: 2,
          __inspireLiveId: id,
        },
      });
    }
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["first", "second"],
    );
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
            messages: [
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
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
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
    let releaseSnapshots!: () => void;
    const snapshots = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
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
            projectionConflict: { message: "ownership conflict", revision: 2 },
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
      let releaseSnapshot!: (value: {
        status: number;
        body: { error: string };
      }) => void;
      const failedSnapshot = new Promise<{
        status: number;
        body: { error: string };
      }>((resolve) => {
        releaseSnapshot = resolve;
      });
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

  it("keeps conflict abortable while an extension dialog is pending", async () => {
    let aborts = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/abort")) {
        aborts += 1;
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "blocked",
      method: "confirm",
      title: "Blocked",
    });
    socket.emit({
      type: "session_projection_conflict",
      sessionId: "s1",
      conflict: { message: "conflict", revision: 2 },
      sessionStatus: { runState: "conflict" },
    });
    expect(store.getState().extensionUiRequests[0]?.id).toBe("blocked");
    expect(store.getState().runState).toBe("conflict");
    await store.abort();
    expect(aborts).toBe(1);
  });

  it("reconciles a selected preview when its runtime becomes ready", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({
            messages: [
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
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolveGate) => {
      releaseOpen = resolveGate;
    });
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
                messages: [
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
                messages: [
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
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolveGate) => {
      releaseSnapshot = resolveGate;
    });
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
                messages: [
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
        messages: [{ role: "assistant", content: "current B", timestamp: 4 }],
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
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolveGate) => {
      releaseResponse = resolveGate;
    });
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
              messages: [{ role: "user", content: "new", timestamp: 2 }],
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

  it("uses each returned cursor to load consecutive older pages", async () => {
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              messages: [{ role: "user", content: "new", timestamp: 3 }],
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
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
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

  it("retains loaded older pages across append-lineage resync but replaces them on rewrite", async () => {
    let snapshotRevision = 5;
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
              revision: snapshotRevision,
              viewId: snapshotRevision === 5 ? "view-a" : "view-b",
              incarnation: "incarnation",
              effectiveLeafId: snapshotRevision === 5 ? "m3" : "compact",
              appendFromRevision: snapshotRevision === 5 ? 1 : 6,
              messages:
                snapshotRevision === 5
                  ? [
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
                    ]
                  : [
                      {
                        role: "user",
                        content: "rewrite",
                        timestamp: 9,
                        __inspireMessageId: "rewrite:0",
                      },
                    ],
              hasOlder: false,
              olderCursor: null,
            },
            effectiveLeafId: snapshotRevision === 5 ? "m3" : "compact",
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

    snapshotRevision = 6;
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 6,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(store.getState().transcriptRevision).toBe(6));
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["rewrite"],
    );
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
                message: "projection conflict",
                revision: 4,
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
              messages: [{ role: "user", content: "new", timestamp: 2 }],
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

  it("keeps the optimistic level when the API accepts the change", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking"))
        return { body: { ok: true } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.setThinkingLevel("low");
    expect(store.getState().thinkingLevel).toBe("low");
    expect(store.getState().error).toBeNull();
  });
});

describe("session switching guard", () => {
  beforeEach(() => installFakeWebSocket());

  it("allows a newer selection to supersede a pending switch without stale cleanup", async () => {
    installFetch(baseRoutes);
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();
    expect(store.getState().sessionId).toBe("s1");

    let openCalls = 0;
    const releases: Record<string, () => void> = {};
    const gates: Record<string, Promise<void>> = {};
    for (const id of ["s2", "s3"]) {
      gates[id] = new Promise<void>((resolve) => {
        releases[id] = resolve;
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          openCalls += 1;
          const id = (JSON.parse(String(init?.body ?? "{}")) as { id: string })
            .id;
          await gates[id]!;
          return new Response(
            JSON.stringify(activeSnapshot({ sessionId: id, cwd: `/${id}` })),
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

    const first = store.openSession("s2");
    expect(store.getState().openingSessionId).toBe("s2");
    const second = store.openSession("s3");
    expect(store.getState().openingSessionId).toBe("s3");
    expect(openCalls).toBe(2);

    releases.s2!();
    await first;
    // The stale first finally cannot clear the newer opener.
    expect(store.getState().openingSessionId).toBe("s3");
    expect(store.getState().sessionId).toBe("s1");

    releases.s3!();
    await second;
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().sessionId).toBe("s3");
    expect(store.getState().error).toBeNull();

    await store.openSession("s3"); // already active: no-op
    expect(openCalls).toBe(2);
  });

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

describe("notice expiry", () => {
  beforeEach(() => {
    installFakeWebSocket();
    installFetch(baseRoutes);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("cancels the expiry timer when a notice is dismissed manually", async () => {
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Indexed 3 files",
    });
    const notice = store.getState().notices.at(-1)!;
    expect(notice.text).toBe("Indexed 3 files");

    const listener = vi.fn();
    store.subscribe(listener);
    store.dismissNotice(notice.id);
    expect(store.getState().notices).toHaveLength(0);
    listener.mockClear();

    // the cancelled timer must never fire a stray publish afterwards
    vi.advanceTimersByTime(60_000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().notices).toHaveLength(0);
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

  it("patches only the fields a curation action changes, and keeps pin and hidden exclusive", async () => {
    const patches: Array<Record<string, unknown>> = [];
    installFetch(curationRoutes("ok", (patch) => patches.push(patch)));
    const { store } = await initStore();

    store.toggleSessionHidden("s7");
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s7"]);

    // Pinning a hidden session unhides it, in one patch carrying both lists.
    store.toggleSessionPin("s7");
    expect(store.getState().prefs).toMatchObject({
      pinnedSessionIds: ["s7"],
      hiddenSessionIds: [],
    });

    store.toggleProjectPin("/demo");
    expect(store.getState().prefs.pinnedProjectCwds).toEqual(["/demo"]);

    await vi.waitFor(() => expect(patches).toHaveLength(3));
    expect(patches).toEqual([
      { hiddenSessionIds: ["s7"] },
      { pinnedSessionIds: ["s7"], hiddenSessionIds: [] },
      { pinnedProjectCwds: ["/demo"] },
    ]);
    expect(store.getState().error).toBeNull();
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

  it("keeps a newer local change when an older write is refused", async () => {
    let failNext = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        if (failNext) {
          failNext = false;
          return { status: 500, body: { error: "preference write rejected" } };
        }
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark"); // this write fails
    store.setTheme("light"); // …but a newer local change already owns the field
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
    expect(store.getState().prefs.theme).toBe("light");
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

  it("loads a bounded reference page for the current branch revision", async () => {
    installFetch(resourceRoutes());
    const { store } = await initStore();

    await expect(store.loadSessionResources()).resolves.toMatchObject({
      sessionId: "s1",
      viewId: "view-s1",
      revision: 1,
      total: 1,
      resources: [{ reference: "notes/result.md" }],
    });
  });

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

  it("keeps incomplete probe batches visibly unknown and retryable", async () => {
    let calls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        calls += 1;
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results:
              calls === 1
                ? [{ reference: body.references[0], availability: "available" }]
                : body.references.map((reference) => ({
                    reference,
                    availability: "available",
                  })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();

    await store.probeResources(["first.md", "omitted.md"]);
    expect(store.getState().resourceAvailability["first.md"]).toBeUndefined();
    expect(store.getState().resourceAvailability["omitted.md"]).toMatchObject({
      availability: "unknown",
    });

    await store.probeResources(["first.md", "omitted.md"]);
    expect(calls).toBe(2);
    expect(store.getState().resourceAvailability["omitted.md"]).toBeUndefined();
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
    let release!: () => void;
    let started!: () => void;
    let responseRevision = 1;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
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
    const oldProbe = deferredResponse();
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
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
        if (requestToken(init) === "old-token") {
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
    expect(freshSocket.url).toContain("token=fresh-token");
    expect(store.getState().resourceAvailability).toEqual({});
  });

  it("opens the pane, resolves the reference, and loads the text preview", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store } = await initStore();

    await store.openResource("notes/result.md");
    const state = store.getState();
    expect(state.resourcesOpen).toBe(true);
    expect(state.selectedResourceReference).toBe("notes/result.md");
    expect(state.resourcePreview).toMatchObject({
      status: "ready",
      truncated: false,
    });
    expect((state.resourcePreview as { text?: string }).text).toContain(
      "Notes body",
    );
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

  it("marks the preview truncated only when the body is shorter than the file", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes bo", { "Content-Range": "bytes 0-9/12" }); // 10 of the current 12 bytes arrived
    const { store } = await initStore();

    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: true,
    });
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
    let firstTransferStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (firstTransferStarted = resolve),
    );
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
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    expect(await blob.text()).toContain("png");
    expect(range).toBe(`bytes=0-${MAX_MEDIA_PREVIEW_BYTES}`);
    await expect(
      store.loadEmbeddedImage(
        "s1",
        "obsolete",
        "pi-embedded://4/0",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts a pending preview when the pane closes", async () => {
    let transferStarted!: () => void;
    const started = new Promise<void>((resolve) => (transferStarted = resolve));
    let signal: AbortSignal | undefined;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "pending",
            sessionId: "s1",
            reference: "pending.pdf",
            name: "pending.pdf",
            mimeType: "application/pdf",
            size: 12,
            kind: "pdf",
          },
        };
      }
      if (url.includes("/api/resources/pending/content")) {
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
    const { store } = await initStore();

    const opening = store.openResource("pending.pdf");
    await started;
    store.setResourcesOpen(false);
    await opening;

    expect(signal?.aborted).toBe(true);
    expect(store.getState().resourcePreview).toBeNull();
  });

  it("aborts a pending preview when the session changes", async () => {
    let transferStarted!: () => void;
    const started = new Promise<void>((resolve) => (transferStarted = resolve));
    let signal: AbortSignal | undefined;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "owned-by-s1",
            sessionId: "s1",
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

  it("closing the pane clears the loaded preview", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store } = await initStore();

    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview?.status).toBe("ready");
    store.setResourcesOpen(false);
    expect(store.getState().resourcesOpen).toBe(false);
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().selectedResourceReference).toBeNull();
  });
});

describe("prompt delivery freeze", () => {
  beforeEach(() => installFakeWebSocket());

  it("freezes withdrawals and repeat sends in flight, then clears only what was delivered", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(
      (resolve) => (releasePrompt = resolve),
    );
    let promptCalls = 0;
    let uploads = 0;
    const deletes: string[] = [];
    installFetch(async (url, init) => {
      if (url.startsWith("/api/attachments") && init.method === "DELETE") {
        deletes.push(url);
        return { body: { ok: true } };
      }
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
        promptCalls += 1;
        await promptGate;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
    const sentLocalId = store.getState().attachments[0]!.localId;

    const send = store.sendPrompt("use the attachment");
    expect(store.getState().sending).toBe(true);

    // Withdrawing the in-flight attachment must neither mutate state nor
    // DELETE the host file the prompt is resolving into the message.
    store.removeAttachment(sentLocalId);
    expect(store.getState().attachments).toHaveLength(1);
    expect(deletes).toHaveLength(0);

    // A repeat send while one is in flight is refused outright.
    await expect(store.sendPrompt("again")).resolves.toBe(false);
    expect(promptCalls).toBe(1);

    // Files staged during the flight belong to the next message.
    await store.addFiles([
      new File(["late"], "late.txt", { type: "text/plain" }),
    ]);
    expect(store.getState().attachments).toHaveLength(2);

    releasePrompt();
    await expect(send).resolves.toBe(true);
    expect(store.getState().sending).toBe(false);
    expect(store.getState().attachments.map((item) => item.fileName)).toEqual([
      "file-2.txt",
    ]);
    expect(deletes).toHaveLength(0);
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
    expect(promptBodies.at(-1)).toEqual({ sessionId: "s2", message: "from B" });

    // Switching back restores A's staged work untouched.
    socket.emit({ type: "snapshot", data: activeSnapshot() });
    expect(store.getState().attachments.map((item) => item.fileName)).toEqual([
      "file-1.txt",
    ]);
    expect(store.getState().projectFiles).toEqual(["src/index.ts"]);
  });

  it("a slow send settles into its owner session's partition only", async () => {
    let uploads = 0;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(
      (resolve) => (releasePrompt = resolve),
    );
    installFetch(async (url, init) => {
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
        await promptGate;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.addFiles([new File(["a"], "a.txt", { type: "text/plain" })]);
    const send = store.sendPrompt("from A");
    expect(store.getState().sending).toBe(true);

    // Switch to B mid-flight: B's composer is free and usable immediately.
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "B" }),
    });
    expect(store.getState().sending).toBe(false);
    await store.addFiles([new File(["b"], "b.txt", { type: "text/plain" })]);
    expect(store.getState().attachments).toHaveLength(1);

    releasePrompt();
    await expect(send).resolves.toBe(true);
    // The settled send cleared A's partition, never B's visible composer.
    expect(store.getState().attachments.map((item) => item.fileName)).toEqual([
      "file-2.txt",
    ]);
    socket.emit({ type: "snapshot", data: activeSnapshot() });
    expect(store.getState().attachments).toEqual([]);
    expect(store.getState().sending).toBe(false);
  });
});

describe("prompt result ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("does not clear another session's visible error after a delayed success", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/prompt")) {
        await promptGate;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const sending = store.sendPrompt("from A");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "B" }),
    });
    socket.emit({
      type: "session_projection_conflict",
      sessionId: "s2",
      conflict: { message: "B's visible error", revision: 2 },
      sessionStatus: { runState: "conflict" },
    });
    releasePrompt();

    await expect(sending).resolves.toBe(true);
    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().error).toBe("B's visible error");
  });

  it("does not replace another session's visible error after a delayed failure", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/prompt")) {
        await promptGate;
        return { status: 500, body: { error: "A failed" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const sending = store.sendPrompt("from A");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "B" }),
    });
    socket.emit({
      type: "session_projection_conflict",
      sessionId: "s2",
      conflict: { message: "B's visible error", revision: 2 },
      sessionStatus: { runState: "conflict" },
    });
    releasePrompt();

    await expect(sending).resolves.toBe(false);
    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().error).toBe("B's visible error");
  });
});

describe("async completion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("a slower, earlier session search cannot overwrite a newer query's results", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions?")) {
        const query = /[?&]q=([^&]*)/.exec(url)?.[1] ?? "";
        if (query === "old") {
          await oldGate;
          return {
            body: {
              sessions: [sessionSummary({ id: "old-hit", title: "Old" })],
              total: 1,
              offset: 0,
              limit: 40,
            },
          };
        }
        if (query === "new") {
          return {
            body: {
              sessions: [sessionSummary({ id: "new-hit", title: "New" })],
              total: 1,
              offset: 0,
              limit: 40,
            },
          };
        }
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const slow = store.loadSessions("old");
    await store.loadSessions("new");
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "new-hit",
    ]);

    releaseOld();
    await slow;
    // The stale response arrived after a newer query and was discarded.
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "new-hit",
    ]);
  });

  it("a delayed rename response cannot retitle a different session", async () => {
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(
      (resolve) => (releaseRename = resolve),
    );
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

  it("deselects the authoritative active session for the New session surface", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/sessions/deselect")) {
        return {
          body: {
            active: null,
            runState: "idle",
            sessionStatuses: { s1: { runState: "idle" } },
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().sessionId).toBe("s1");

    await expect(store.deselectSession()).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      sessionId: null,
      sessionName: "",
      cwd: null,
      runState: "idle",
      messages: [],
      statuses: {},
      extensionDisplays: [],
    });
  });

  it("does not let a delayed deselect override a newer session selection", async () => {
    let releaseDeselect!: () => void;
    const deselectGate = new Promise<void>((resolveGate) => {
      releaseDeselect = resolveGate;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/deselect")) {
        await deselectGate;
        return {
          body: { active: null, runState: "idle", sessionStatuses: {} },
        };
      }
      if (url.startsWith("/api/sessions/open")) {
        return { body: activeSnapshot({ sessionId: "s-B", sessionName: "B" }) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const deselecting = store.deselectSession();
    expect(store.getState().sessionSelectionPending).toBe(true);
    await store.openSession("s-B");
    expect(store.getState().sessionSelectionPending).toBe(false);
    releaseDeselect();
    await expect(deselecting).resolves.toBe(false);
    expect(store.getState().sessionId).toBe("s-B");
  });

  it("a late open response cannot override a newer session selection", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/open")) {
        await openGate;
        return { body: activeSnapshot({ sessionId: "s-A", sessionName: "A" }) };
      }
      if (url.startsWith("/api/sessions/new")) {
        return { body: activeSnapshot({ sessionId: "s-B", sessionName: "B" }) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const opening = store.openSession("s-A"); // ticket 1, gated
    await store.newSession("/proj", "B"); // ticket 2, applies B
    expect(store.getState().sessionId).toBe("s-B");

    releaseOpen();
    await opening;
    // The stale open response is discarded; the newer selection stands.
    expect(store.getState().sessionId).toBe("s-B");
  });

  it("returns no created identity when a newer selection supersedes session creation", async () => {
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolveGate) => {
      releaseNew = resolveGate;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/new")) {
        await newGate;
        return { body: activeSnapshot({ sessionId: "s-B", sessionName: "B" }) };
      }
      if (url.startsWith("/api/sessions/open")) {
        return { body: activeSnapshot({ sessionId: "s-C", sessionName: "C" }) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const creating = store.newSession("/proj", "B");
    await store.openSession("s-C");
    releaseNew();

    await expect(creating).resolves.toBeNull();
    expect(store.getState().sessionId).toBe("s-C");
  });

  it("a successful new session clears the superseded opener", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolveGate) => {
      releaseOpen = resolveGate;
    });
    installFetch(async (url) => {
      if (url.startsWith("/api/sessions/open")) {
        await openGate;
        return { body: activeSnapshot({ sessionId: "s-A", sessionName: "A" }) };
      }
      if (url.startsWith("/api/sessions/new")) {
        return { body: activeSnapshot({ sessionId: "s-B", sessionName: "B" }) };
      }
      return baseRoutes(url, {});
    });
    const { store } = await initStore();

    const opening = store.openSession("s-A");
    expect(store.getState().openingSessionId).toBe("s-A");
    await store.newSession("/proj", "B");
    expect(store.getState().sessionId).toBe("s-B");
    expect(store.getState().openingSessionId).toBeNull();

    releaseOpen();
    await opening;
    expect(store.getState().sessionId).toBe("s-B");
    expect(store.getState().openingSessionId).toBeNull();
  });

  it("an authoritative push invalidates an in-flight open response", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
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
    let releaseThinking!: () => void;
    const gate = new Promise<void>((resolve) => (releaseThinking = resolve));
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
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolvePatch) => {
      releasePatch = resolvePatch;
    });
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
