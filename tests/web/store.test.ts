// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore, shallowEqual, store, useAppState } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  type RouteResponse,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";
import { initStore, installStoreRoutes } from "./store-fixture";

beforeEach(() => installFakeWebSocket());
afterEach(() => {
  if (!vi.isFakeTimers()) return;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("websocket lifecycle", () => {
  it("accepts low event sequences from a restarted Host on the same session", async () => {
    const nextHost = "22222222-2222-4222-8222-222222222222";
    let authorityId = TEST_HOST_AUTHORITY;
    const snapshot = activeSnapshot();
    installStoreRoutes((url) =>
      url.startsWith("/api/bootstrap")
        ? { body: bootstrapPayload({ authorityId, startupSessionId: "s1" }) }
        : undefined,
    );
    const { store, socket } = await initStore();
    const publish = (
      peer: FakeWebSocket,
      runtimeSequence: number,
      content: string,
    ) =>
      peer.emit({
        type: "session_projection_changed",
        sessionId: "s1",
        runtimeSequence,
        transcript: activeSnapshot({
          transcriptPage: { messages: [{ role: "assistant", content }] },
        }).active,
      });
    publish(socket, 200, "before restart");
    expect(store.getState().messages.at(-1)?.content).toBe("before restart");
    authorityId = nextHost;
    await store.init();
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.join(snapshot, { authorityId: nextHost });
    publish(replacement, 2, "after restart");
    expect(store.getState().messages.at(-1)?.content).toBe("after restart");
  });

  it("keeps a newer HTTP observation when a joined snapshot was captured earlier", async () => {
    const current = activeSnapshot({
      pageMessages: [{ role: "assistant", content: "Already confirmed" }],
    });
    installStoreRoutes((url) =>
      url.startsWith("/api/snapshot")
        ? { body: { ...current, runtimeSequence: 12 } }
        : undefined,
    );
    const { store } = await initStore();
    await store.init();
    const peer = FakeWebSocket.instances.at(-1)!;
    peer.open();
    await store.refreshSession();
    peer.emitSnapshot(activeSnapshot(), {
      detailSessionId: "s1",
      detailRevision: 0,
      runtimeSequence: 11,
    });
    expect(store.getState()).toMatchObject({
      connection: "open",
      messages: [{ role: "assistant", content: "Already confirmed" }],
    });
  });

  it.each(["replacement", "deadline"] as const)(
    "ignores a retired bootstrap response after %s",
    async (boundary) => {
      vi.useFakeTimers();
      const retired = deferred<RouteResponse>();
      let signal: AbortSignal | null | undefined;
      const snapshot = activeSnapshot({ sessionId: "current-session" });
      const current = bootstrapPayload({
        version: "current-host",
        preferences: { ...DEFAULT_PREFS, theme: "dark" },
        startupSessionId: "current-session",
      });
      const fetch = installStoreRoutes((url, init) => {
        if (!url.startsWith("/api/bootstrap")) return;
        if (signal) return { body: current };
        signal = init.signal;
        return retired.promise;
      });
      const store = new AppStore();
      const first = store.init();
      if (boundary === "deadline") {
        await vi.advanceTimersByTimeAsync(45_000);
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
      expect(signal?.aborted).toBe(true);
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.join(snapshot);
      retired.resolve(
        boundary === "deadline"
          ? { status: 401, body: { error: "Expired pairing" } }
          : {
              body: bootstrapPayload({
                version: "retired-host",
                startupSessionId: "retired-session",
              }),
            },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({
        connection: "open",
        sessionId: "current-session",
        version: "current-host",
        prefs: { theme: "dark" },
        needsToken: false,
      });
      expect(FakeWebSocket.instances).toEqual([socket]);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/bootstrap"),
        ),
      ).toHaveLength(2);
    },
  );

  it.each(["address-unreachable", "service-error"] as const)(
    "reports %s without asking for pairing",
    async (kind) => {
      vi.useFakeTimers();
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

  it.each(["committed", "pending"])(
    "preserves a newer %s selection during missing-detail recovery",
    async (phase) => {
      const opening = deferred<RouteResponse>();
      installStoreRoutes((url) =>
        url === "/api/sessions/open" ? opening.promise : undefined,
      );
      const { store } = await initStore();
      await store.init();
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      const selecting = store.openSession("s2");
      const finish = () =>
        opening.resolve({ body: activeSnapshot({ sessionId: "s2" }) });
      if (phase === "committed") {
        finish();
        await selecting;
      }
      socket.emitSnapshot(
        { active: null, runState: "idle", sessionStatuses: {} },
        { detailSessionId: "s1", detailRevision: 0, missingDetail: true },
      );
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
      expect(store.getState().notices).not.toContainEqual(
        expect.objectContaining({
          text: expect.stringContaining("previous session no longer exists"),
        }),
      );
    },
  );

  it("retains bootstrap model choices while an active preview has not loaded its worker catalog", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
    ];
    installStoreRoutes((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            availableModels: models,
            startupSessionId: "s1",
          }),
        };
      }
    });
    const { store } = await initStore();
    expect(store.getState().availableModels).toEqual(models);
  });
});

describe("multi-session event routing", () => {
  it("restores live state on an addressed snapshot and clears it when the Host retires it", async () => {
    const { store, socket } = await initStore();
    const running = activeSnapshot({
      toolActivity: { read: { id: "read", name: "read", phase: "running" } },
      isStreaming: true,
    });
    running.sessionStatuses.s2 = { runState: "idle", indicator: "completed" };
    running.pendingExtensionUiRequests = [
      {
        sessionId: "s1",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
      },
    ];
    running.pendingQueues = pendingQueues(["correct the current answer"], [], {
      revision: 2,
    });
    running.extensionStatuses = { usage: "37%" };
    const publish = (snapshot: ReturnType<typeof activeSnapshot>) =>
      socket.emitSnapshot(snapshot, {
        detailSessionId: "s1",
        detailRevision: 0,
      });

    publish(running);
    expect(store.getState()).toMatchObject({
      sessionStatuses: { s2: { indicator: "completed" } },
      extensionUiRequests: running.pendingExtensionUiRequests,
      queue: running.pendingQueues,
      tools: running.active!.toolActivity,
      statuses: { usage: "37%" },
    });

    const settled = activeSnapshot();
    publish(settled);
    expect(store.getState()).toMatchObject({
      sessionStatuses: settled.sessionStatuses,
      extensionUiRequests: [],
      queue: pendingQueues(),
      statuses: {},
      tools: {},
    });
  });

  it("clears selected-only extension presentation when switching sessions", async () => {
    installStoreRoutes(() => undefined);
    const { store, socket } = await initStore();
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "status-1",
      method: "setStatus",
      extensionStatuses: { worker: "indexing" },
    });
    socket.emit({
      type: "extension_ui_request",
      sessionId: "s1",
      id: "title-1",
      method: "setTitle",
      title: "Session A title",
    });
    const publishDraft = (id: string) =>
      socket.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id,
        method: "set_editor_text",
        text: "draft from A",
      });
    publishDraft("editor-1");
    publishDraft("editor-2");
    expect(store.getState()).toMatchObject({
      statuses: { worker: "indexing" },
      windowTitle: "Session A title",
    });
    expect(store.drafts.get("s1").text).toBe("draft from A");

    await selectSession(
      store,
      activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
    );
    expect(store.getState()).toMatchObject({
      statuses: {},
      windowTitle: null,
    });
    expect(store.drafts.get("s1").text).toBe("draft from A");
    expect(store.drafts.get("s2").text).toBe("");
  });

  it("routes background work to the session list while leaving the selected transcript alone", async () => {
    const fetch = installStoreRoutes(() => undefined);
    const { store, socket } = await initStore();
    const listReads = () =>
      fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/sessions?"),
      );
    const listsBefore = listReads().length;
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    const publish = (type: string, fields: Record<string, unknown>) =>
      socket.emit({ type, sessionId: "bg", ...fields });
    const running = { runState: "running", indicator: "running" };
    const message = {
      role: "assistant",
      content: "background draft",
      timestamp: 42,
    };
    try {
      publish("message_start", { message, sessionStatus: running });
      expect(store.getState().sessionStatuses.bg).toEqual(running);

      notify.mockClear();
      publish("message_update", {
        message: { ...message, content: "more tokens" },
        sessionStatus: running,
      });
      expect(notify).not.toHaveBeenCalled();

      for (const needsInput of [true, false]) {
        publish("session_status", {
          sessionStatus: { ...running, indicator: "attention", needsInput },
        });
        expect(store.getState().sessionStatuses.bg.needsInput).toBe(needsInput);
      }

      publish("runtime_ready", { sessionStatus: { runState: "idle" } });
      const completed = { runState: "idle", indicator: "completed" };
      publish("agent_settled", { sessionStatus: completed });
      await vi.waitFor(() => expect(listReads()).toHaveLength(listsBefore + 1));
      expect(fetch.mock.calls).not.toContainEqual(
        expect.arrayContaining([expect.stringMatching(/^\/api\/snapshot/)]),
      );
      expect(store.getState()).toMatchObject({
        messages: [],
        streaming: false,
        extensionUiRequests: [],
        sessionStatuses: { bg: completed },
      });
    } finally {
      unsubscribe();
    }
  });

  it("installs native rows and branch ownership together and fences an older HTTP read", async () => {
    const old = deferred<RouteResponse>();
    const fetch = installStoreRoutes((url) =>
      url.startsWith("/api/snapshot") ? old.promise : undefined,
    );
    const { store, socket } = await initStore();
    store.drafts.setText("s1", "keep this draft");
    const seen: Array<[string | null, unknown]> = [];
    const unsubscribe = store.subscribe(() => {
      const { transcriptViewId, messages } = store.getState();
      seen.push([transcriptViewId, messages.at(-1)?.content]);
    });
    try {
      const refresh = store.refreshSession();
      await vi.waitFor(() =>
        expect(
          fetch.mock.calls.some(([url]) =>
            String(url).startsWith("/api/snapshot"),
          ),
        ).toBe(true),
      );
      socket.emit({
        type: "branch_changed",
        sessionId: "s1",
        runtimeSequence: 12,
        transcript: activeSnapshot({
          branchRevision: 2,
          durableLeafId: "native-leaf",
          transcriptPage: {
            viewId: "new-view",
            revision: 2,
            effectiveLeafId: "native-leaf",
            messages: [{ role: "assistant", content: "saved native text" }],
          },
        }).active,
      });
      old.resolve({ body: { ...activeSnapshot(), runtimeSequence: 11 } });
      await refresh;
      expect(seen).toContainEqual(["new-view", "saved native text"]);
      for (const [view, text] of seen)
        expect(view === "new-view").toBe(text === "saved native text");
      expect(store.getState()).toMatchObject({
        branchRevision: 2,
        transcriptEffectiveLeafId: "native-leaf",
      });
      expect(store.drafts.get("s1").text).toBe("keep this draft");
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/snapshot"),
        ),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
      store.drafts.setText("s1", "");
    }
  });

  it("recovers an invalid detail replacement without publishing partial diagnostics", async () => {
    vi.useFakeTimers();
    const { store, socket } = await initStore();
    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      health: { status: "error", message: "Invalid partial diagnostic" },
    });
    expect(store.getState()).toMatchObject({
      connection: "reconnecting",
      projectionHealth: { status: "ok" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances.at(-1)!.join(
      activeSnapshot({
        pageMessages: [
          { role: "assistant", content: "Confirmed on reconnect" },
        ],
      }),
    );
    expect(store.getState()).toMatchObject({
      connection: "open",
      messages: [{ content: "Confirmed on reconnect" }],
    });
  });

  it("keeps stamped projection diagnostics through a failed refresh and clears them on recovery", async () => {
    vi.useFakeTimers();
    const recovery = deferred<RouteResponse>();
    const refresh = vi
      .fn()
      .mockReturnValueOnce({
        status: 503,
        body: { error: "snapshot unavailable" },
      })
      .mockReturnValueOnce(recovery.promise);
    installStoreRoutes((url) =>
      url.startsWith("/api/snapshot") ? refresh() : undefined,
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
      transcriptRevision: 2,
      projectionConflict: conflict,
      error: conflict.message,
      errorSeverity: "error",
    });
    expect(refresh).not.toHaveBeenCalled();
    socket.emit({ type: "runtime_ready", sessionId: "s1", runtimeSequence: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.getState().error).toBe(conflict.message);
    recovery.resolve({
      body: {
        ...activeSnapshot({
          transcriptPage: { revision: 3, appendFromRevision: 2 },
        }),
        runtimeSequence: 3,
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState()).toMatchObject({
      transcriptRevision: 3,
      projectionHealth: { status: "ok" },
      projectionError: null,
      error: null,
    });
  });

  it("clears Pending without replacing newer queue events with a receipt", async () => {
    const clear = deferred<RouteResponse>();
    const fetch = installStoreRoutes((url) =>
      url === "/api/pending/clear" ? clear.promise : undefined,
    );
    const { store, socket } = await initStore();
    const active = activeSnapshot();
    active.pendingQueues = pendingQueues(["one"]);
    socket.emitSnapshot(active);
    const clearing = store.clearPending();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/pending/clear",
        expect.objectContaining({
          body: JSON.stringify({ sessionId: "s1" }),
        }),
      ),
    );
    await expect(store.clearPending()).resolves.toBe(false);
    expect(store.getState().queue).toEqual(active.pendingQueues);
    const newer = pendingQueues(["arrived after clear"], [], { revision: 2 });
    socket.emit({
      type: "queue_update",
      sessionId: "s1",
      pendingQueues: newer,
    });
    clear.resolve({ body: { ok: true } });
    await expect(clearing).resolves.toBe(true);
    expect(store.getState().queue).toEqual(newer);
    expect(store.getState().pendingAction).toBeNull();
  });

  it("loads live state when runtime_ready arrives before an open response", async () => {
    const release = deferred<void>();
    const fetch = installStoreRoutes(async (url) => {
      if (url === "/api/sessions/open") {
        await release.promise;
        return { body: activeSnapshot({ sessionId: "s2" }) };
      }
      if (url === "/api/snapshot?detail=s2")
        return {
          body: activeSnapshot({
            sessionId: "s2",
            pageMessages: [
              { role: "assistant", content: "live runtime", timestamp: 2 },
            ],
          }),
        };
    });
    const { store, socket } = await initStore();
    const opening = store.openSession("s2");
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions/open",
        expect.anything(),
      ),
    );
    socket.emit({
      type: "runtime_ready",
      sessionId: "s2",
      sessionStatus: { runState: "idle" },
    });
    release.resolve();
    await opening;
    await vi.waitFor(() =>
      expect(
        store.getState().messages.map((message) => message.content),
      ).toEqual(["live runtime"]),
    );
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/snapshot"),
      ),
    ).toHaveLength(1);
  });

  it("rerenders a shallow object selection only when a selected value changes", () => {
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
    const initialRenders = rendered.mock.calls.length;
    act(() => store.setWorkspaceQuery("notes"));
    expect(rendered).toHaveBeenCalledTimes(initialRenders);

    act(() => store.setResourcesOpen(true));
    expect(screen.getByRole("status")).toHaveTextContent("Resources open");
    cleanup();
    store.setWorkspaceQuery("");
    store.setResourcesOpen(false);
  });
});
