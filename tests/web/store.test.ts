// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore, injectHtmlPreviewCsp } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  type RouteHandler,
} from "./helpers";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

async function initStore(): Promise<{ store: AppStore; socket: FakeWebSocket }> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}

describe("websocket lifecycle", () => {
  beforeEach(() => installFakeWebSocket());

  it("does not issue an HTTP resync on open; the pushed snapshot is authoritative", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) snapshotCalls += 1;
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    expect(snapshotCalls).toBe(0);
    socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "s9" }) });
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

  it("applies snapshot sessionStatuses wholesale into state", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    expect(store.getState().sessionStatuses).toEqual({ s1: { runState: "idle" } });
    const snapshot = activeSnapshot();
    snapshot.sessionStatuses = {
      s1: { runState: "idle" },
      s2: { runState: "idle", indicator: "completed" },
    };
    snapshot.pendingExtensionUi = { sessionId: "s1", id: "question-1", method: "confirm", title: "Proceed?" };
    socket.emit({ type: "snapshot", data: snapshot });
    expect(store.getState().sessionStatuses).toEqual({
      s1: { runState: "idle" },
      s2: { runState: "idle", indicator: "completed" },
    });
    expect(store.getState().extensionUi).toEqual({ sessionId: "s1", id: "question-1", method: "confirm", title: "Proceed?" });

    snapshot.pendingExtensionUi = null;
    socket.emit({ type: "snapshot", data: snapshot });
    expect(store.getState().extensionUi).toBeNull();
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

    socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }) });
    expect(store.getState()).toMatchObject({ statuses: {}, windowTitle: null, editorText: null });
  });

  it("routes background deltas only to the status map, never the visible transcript", async () => {
    let snapshotCalls = 0;
    let sessionListCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) snapshotCalls += 1;
      if (url.startsWith("/api/sessions")) sessionListCalls += 1;
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
      message: { role: "assistant", content: "background draft", timestamp: 42 },
    });
    expect(store.getState().messages).toEqual([]); // visible transcript untouched
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().sessionStatuses.bg).toEqual({ runState: "running", indicator: "running" });
    expect(listener).toHaveBeenCalledTimes(1); // the status change publishes once

    // unchanged background status (token chatter) publishes nothing
    listener.mockClear();
    socket.emit({
      type: "message_update",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
      message: { role: "assistant", content: "background draft continues", timestamp: 42 },
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
    await vi.waitFor(() => expect(sessionListCalls).toBe(sessionsAfterInit + 1));
    expect(snapshotCalls).toBe(0);
    expect(store.getState().sessionStatuses.bg).toEqual({ runState: "idle", indicator: "completed" });
    expect(store.getState().messages).toEqual([]);
  });

  it("reconciles a selected preview when its runtime becomes ready", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({ messages: [{ role: "assistant", content: "live runtime", timestamp: 2 }] }),
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
    await vi.waitFor(() => expect(store.getState().messages).toEqual([
      { role: "assistant", content: "live runtime", timestamp: 2 },
    ]));
  });

  it("reconciles readiness that arrives before the open response", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolveGate) => {
      releaseOpen = resolveGate;
    });
    let openRequested = false;
    let snapshotCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/sessions/open")) {
        openRequested = true;
        await openGate;
        return new Response(JSON.stringify(activeSnapshot({
          sessionId: "s2",
          messages: [{ role: "assistant", content: "preview B", timestamp: 2 }],
        })), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return new Response(JSON.stringify(activeSnapshot({
          sessionId: "s2",
          messages: [{ role: "assistant", content: "live B", timestamp: 3 }],
        })), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const route = baseRoutes(url, init ?? {}) ?? { status: 404, body: { error: "missing route" } };
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { store, socket } = await initStore();
    const opening = store.openSession("s2");
    await vi.waitFor(() => expect(openRequested).toBe(true));
    expect(store.getState().openingSessionId).toBe("s2");

    socket.emit({ type: "runtime_ready", sessionId: "s2", sessionStatus: { runState: "idle" } });
    releaseOpen();
    await opening;

    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    await vi.waitFor(() => expect(store.getState().messages).toEqual([
      { role: "assistant", content: "live B", timestamp: 3 },
    ]));
  });

  it("does not let a delayed resync replace a newer session selection", async () => {
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolveGate) => {
      releaseSnapshot = resolveGate;
    });
    let snapshotRequested = false;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/snapshot")) {
        snapshotRequested = true;
        await snapshotGate;
        return new Response(JSON.stringify(activeSnapshot({
          sessionId: "s1",
          messages: [{ role: "assistant", content: "stale A", timestamp: 3 }],
        })), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const route = baseRoutes(url, init ?? {}) ?? { status: 404, body: { error: "missing route" } };
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { store, socket } = await initStore();
    socket.emit({ type: "runtime_ready", sessionId: "s1", sessionStatus: { runState: "idle" } });
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

    expect(store.getState().messages).toEqual([{ role: "assistant", content: "current B", timestamp: 4 }]);
  });

  it("keeps extension responses bound to their owning session across navigation", async () => {
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolveGate) => {
      releaseResponse = resolveGate;
    });
    let responseBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/extension-ui")) {
        responseBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        await responseGate;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const route = baseRoutes(url, init ?? {}) ?? { status: 404, body: { error: "missing route" } };
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "question-a",
      method: "confirm",
      title: "Question A",
    });

    const responding = store.respondExtensionUi({ id: "question-a", confirmed: true });
    await vi.waitFor(() => expect(responseBody).toMatchObject({ sessionId: "s1", id: "question-a" }));
    const sessionB = activeSnapshot({ sessionId: "s2", sessionName: "Session B" });
    sessionB.pendingExtensionUi = {
      sessionId: "s2",
      id: "question-b",
      method: "confirm",
      title: "Question B",
    };
    socket.emit({ type: "snapshot", data: sessionB });
    releaseResponse();
    await responding;

    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().extensionUi).toMatchObject({ sessionId: "s2", id: "question-b" });
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
    expect(store.getState().sessionStatuses.s1).toEqual({ runState: "running", indicator: "running" });
  });
});

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it("rolls back to the truthful level and resyncs when the API rejects the change", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) return { status: 500, body: { error: "unsupported level" } };
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
    expect(store.getState().error).toBe("unsupported level");
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(0));
  });

  it("keeps the optimistic level when the API accepts the change", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) return { body: { ok: true } };
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

  it("ignores duplicate selections while a switch is pending and no-ops on the active session", async () => {
    installFetch(baseRoutes);
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();
    expect(store.getState().sessionId).toBe("s1");

    let openCalls = 0;
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          openCalls += 1;
          await gate;
          return new Response(JSON.stringify(activeSnapshot({ sessionId: "s2", cwd: "/other" })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      }),
    );

    const first = store.openSession("s2");
    // the pending switch is visible synchronously so rows can show it
    expect(store.getState().openingSessionId).toBe("s2");
    await store.openSession("s3"); // conflicting selection ignored
    await store.openSession("s2"); // duplicate of the pending target ignored
    expect(openCalls).toBe(1);

    releaseOpen();
    await first;
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().error).toBeNull();

    await store.openSession("s2"); // already active: no-op
    expect(openCalls).toBe(1);
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
          return new Response(JSON.stringify({ error: "session is owned by another Pi process" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      }),
    );

    await store.openSession("s9");
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().sessionId).toBe("s1"); // active session unchanged
    expect(store.getState().error).toBe("session is owned by another Pi process");

    // a later selection is not blocked by the failed attempt
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          return new Response(JSON.stringify(activeSnapshot({ sessionId: "s3" })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
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
    socket.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "Indexed 3 files" });
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

describe("session pinning", () => {
  beforeEach(() => installFakeWebSocket());

  const pinnedRoutes = (
    pinBehavior: "ok" | "fail",
    onPin?: (pinned: boolean) => void,
  ): RouteHandler => {
    const summary = { ...activeSnapshot(), };
    void summary;
    return (url, init) => {
      if (url.startsWith("/api/sessions/pin")) {
        const body = JSON.parse(String(init.body ?? "{}")) as { id: string; pinned: boolean };
        onPin?.(body.pinned);
        if (pinBehavior === "fail") return { status: 500, body: { error: "pin rejected" } };
        return {
          body: {
            ...bootstrapPayload().preferences,
            pinnedSessionIds: body.pinned ? [body.id] : [],
          },
        };
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

  it("applies the pin optimistically and confirms with the host's preferences", async () => {
    installFetch(pinnedRoutes("ok"));
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions[0]?.pinned).toBe(false));

    await store.setSessionPinned("s7", true);
    expect(store.getState().prefs.pinnedSessionIds).toEqual(["s7"]);
    expect(store.getState().sessions[0]?.pinned).toBe(true);
    expect(store.getState().pinningSessionId).toBeNull();
    expect(store.getState().error).toBeNull();

    await store.setSessionPinned("s7", false);
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
    expect(store.getState().sessions[0]?.pinned).toBe(false);
  });

  it("rolls back truthfully when the host rejects the pin", async () => {
    installFetch(pinnedRoutes("fail"));
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions[0]?.pinned).toBe(false));

    await store.setSessionPinned("s7", true);
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
    expect(store.getState().sessions[0]?.pinned).toBe(false);
    expect(store.getState().error).toBe("pin rejected");
  });

  it("ignores a duplicate pin mutation while one is in flight", async () => {
    let pinCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/sessions/pin")) {
        pinCalls += 1;
        return pinnedRoutes("ok")(url, init);
      }
      return pinnedRoutes("ok")(url, init);
    });
    const { store } = await initStore();
    await Promise.all([store.setSessionPinned("s7", true), store.setSessionPinned("s7", true)]);
    expect(pinCalls).toBe(1);
  });

  it("fetches pinned sessions missing from the first page", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...bootstrapPayload().preferences, pinnedSessionIds: ["s-pinned"] },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-id")) {
        const body = JSON.parse(String(init.body ?? "{}")) as { ids: string[] };
        expect(body.ids).toEqual(["s-pinned"]);
        return {
          body: {
            sessions: [
              {
                id: "s-pinned",
                cwd: "/elsewhere",
                project: "elsewhere",
                title: "Off-page pinned",
                created: "2026-07-19T10:00:00Z",
                modified: "2026-07-19T11:00:00Z",
                messageCount: 5,
              },
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
    await vi.waitFor(() => {
      const pinned = store.getState().sessions.find((session) => session.id === "s-pinned");
      expect(pinned?.pinned).toBe(true);
      expect(pinned?.title).toBe("Off-page pinned");
    });
  });
});

describe("resource previews", () => {
  beforeEach(() => installFakeWebSocket());

  it("makes sandboxed HTML inert before creating its blob document", () => {
    const html = injectHtmlPreviewCsp('<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script></body></html>');
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<base");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });

  function resourceRoutes(): RouteHandler {
    return (url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = JSON.parse(String(init.body ?? "{}")) as { reference: string };
        if (body.reference.includes("missing")) {
          return { status: 404, body: { error: "The referenced file was not found" } };
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

  function stubContent(text: string): void {
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/") && url.includes("/content")) {
          return new Response(text, { status: 200, headers: { "Content-Type": "text/markdown" } });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
  }

  it("opens the pane, resolves the reference, and loads the text preview", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store } = await initStore();

    await store.openResource("notes/result.md");
    const state = store.getState();
    expect(state.resourcesOpen).toBe(true);
    expect(state.selectedResourceReference).toBe("notes/result.md");
    expect(state.resourcePreview).toMatchObject({ status: "ready", truncated: false });
    expect((state.resourcePreview as { text?: string }).text).toContain("Notes body");
  });

  it("marks the preview truncated only when the body is shorter than the file", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes bo"); // 10 of the descriptor's 12 bytes arrived
    const { store } = await initStore();

    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({ status: "ready", truncated: true });
  });

  it("surfaces a truthful error state when the host rejects the reference", async () => {
    installFetch(resourceRoutes());
    const { store } = await initStore();

    await store.openResource("missing/file.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "error",
      message: "The referenced file was not found",
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
    expect(store.getState().resourcePreview).toMatchObject({ status: "ready", objectUrl: "blob:preview-0" });
    expect(created).toHaveLength(1);

    socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "s2", sessionName: "Other" }) });
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
