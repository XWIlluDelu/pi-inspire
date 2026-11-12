// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTP_OBSERVATION_TIMEOUT_MS } from "../../src/api";
import { AppStore, shallowEqual, store, useAppState } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  type RouteResponse,
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
  it.each(["target changed", "wrong authority", "wrong digest"] as const)(
    "reconnects when an unchanged HTTP-open confirmation no longer attests the selected detail (%s)",
    async (confirmation) => {
      const next = activeSnapshot({ sessionId: "s2" });
      const digest = "b".repeat(64);
      installStoreRoutes((url) =>
        url === "/api/sessions/open"
          ? {
              body: {
                ...next,
                authorityId: TEST_HOST_AUTHORITY,
                snapshotDigest: digest,
              },
            }
          : undefined,
      );
      const { store, socket } = await initStore();
      await store.openSession("s2");
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        type: "detail_interest",
        sessionId: "s2",
        revision: 1,
        authorityId: TEST_HOST_AUTHORITY,
        snapshotDigest: digest,
      });
      socket.emit({
        type: "message_update",
        sessionId: confirmation === "target changed" ? "s2" : "s1",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "detail in flight" }],
        },
      });
      socket.emit({
        type: "snapshot",
        unchanged: true,
        detailSessionId: "s2",
        detailRevision: 1,
        authorityId:
          confirmation === "wrong authority"
            ? "22222222-2222-4222-8222-222222222222"
            : TEST_HOST_AUTHORITY,
        snapshotDigest:
          confirmation === "wrong digest" ? "c".repeat(64) : digest,
      });
      expect(store.getState().connection).toBe("reconnecting");
    },
  );

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
        snapshot,
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
      socket.open(snapshot);
      retired.resolve(
        boundary === "deadline"
          ? { status: 401, body: { error: "Expired pairing" } }
          : {
              body: bootstrapPayload({
                version: "retired-host",
                snapshot: activeSnapshot({ sessionId: "retired-session" }),
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
      const fallback = deferred<RouteResponse>();
      const opening = deferred<RouteResponse>();
      const next = { body: activeSnapshot({ sessionId: "s2" }) };
      const empty = {
        active: null,
        runState: "idle" as const,
        sessionStatuses: {},
      };
      let missing = false;
      let recovering = false;
      installStoreRoutes((url) => {
        if (url === "/api/bootstrap?detail=s1" && missing)
          return {
            status: 404,
            body: { error: "gone", code: "SESSION_NOT_FOUND" },
          };
        if (url === "/api/bootstrap?detail=") {
          recovering = true;
          return fallback.promise;
        }
        if (url === "/api/sessions/open") return opening.promise;
      });
      const { store } = await initStore();
      missing = true;
      const reconnecting = store.init();
      await vi.waitFor(() => expect(recovering).toBe(true));
      const selecting = store.openSession("s2");
      if (phase === "committed") {
        opening.resolve(next);
        await selecting;
      }
      fallback.resolve({ body: bootstrapPayload({ snapshot: empty }) });
      await reconnecting;
      if (phase === "pending") {
        expect(store.getState()).toMatchObject({
          sessionId: null,
          openingSessionId: "s2",
          sessionSelectionPending: true,
        });
        const socket = FakeWebSocket.instances.at(-1)!;
        socket.readyState = FakeWebSocket.OPEN;
        socket.onopen?.({});
        // Match the real addressed handshake, not a legacy selection push.
        socket.emit({
          type: "snapshot",
          detailSessionId: null,
          detailRevision: 0,
          data: empty,
        });
        opening.resolve(next);
        await selecting;
      }
      expect(store.getState().sessionId).toBe("s2");
      expect(
        store
          .getState()
          .notices.some((notice) =>
            notice.text.includes("previous session no longer exists"),
          ),
      ).toBe(false);
    },
  );

  it("keeps the selection when an addressed 404 does not establish absence", async () => {
    let refused = false;
    const reads: string[] = [];
    installStoreRoutes((url) => {
      if (url.startsWith("/api/bootstrap") && refused) {
        reads.push(url);
        return { status: 404, body: { error: "Read refused" } };
      }
    });
    const { store } = await initStore();
    refused = true;
    await store.init();
    expect(reads).toEqual(["/api/bootstrap?detail=s1"]);
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      connection: "offline",
    });
  });

  it("waits for a slow bootstrap and shares the next deadline with missing-detail fallback", async () => {
    vi.useFakeTimers();
    let recovering = false;
    const initial = deferred<RouteResponse>();
    const missing = deferred<RouteResponse>();
    let fallbackSignal: AbortSignal | null | undefined;
    installStoreRoutes((url, init) => {
      if (url === "/api/bootstrap") return initial.promise;
      if (recovering && url === "/api/bootstrap?detail=s1")
        return missing.promise;
      if (recovering && url === "/api/bootstrap?detail=") {
        fallbackSignal = init.signal;
        return new Promise<never>(() => {});
      }
    });
    const store = new AppStore();
    const initializing = store.init();
    await vi.advanceTimersByTimeAsync(35_000);
    const snapshot = activeSnapshot();
    initial.resolve({ body: bootstrapPayload({ snapshot }) });
    await initializing;
    FakeWebSocket.instances.at(-1)!.open(snapshot);
    expect(store.getState().connection).toBe("open");
    recovering = true;
    const reconnecting = store.init();
    await vi.advanceTimersByTimeAsync(35_000);
    missing.resolve({
      status: 404,
      body: { error: "Gone", code: "SESSION_NOT_FOUND" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fallbackSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(HTTP_OBSERVATION_TIMEOUT_MS - 35_000);
    await reconnecting;
    expect(fallbackSignal?.aborted).toBe(true);
    expect(store.getState()).toMatchObject({
      connection: "offline",
      needsToken: false,
      sessionId: "s1",
    });
  });

  it("retains bootstrap model choices while an active preview has not loaded its worker catalog", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
    ];
    installStoreRoutes((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            availableModels: models,
            snapshot: activeSnapshot(),
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
      socket.emit({
        type: "snapshot",
        detailSessionId: "s1",
        detailRevision: 0,
        data: snapshot,
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
    const previousDraft = store.getState().editorText;
    publishDraft("editor-2");
    expect(store.getState()).toMatchObject({
      statuses: { worker: "indexing" },
      windowTitle: "Session A title",
      editorText: { text: "draft from A" },
    });
    expect(store.getState().editorText?.nonce).not.toBe(previousDraft?.nonce);

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

  it.each([3, 4])(
    "coalesces selected projection refreshes and fences reordered responses (latest revision %s)",
    async (revision) => {
      vi.useFakeTimers();
      const earlier = deferred<RouteResponse>();
      const latest = deferred<RouteResponse>();
      const requests = [earlier, latest];
      let reads = 0;
      installStoreRoutes((url) =>
        url.startsWith("/api/snapshot")
          ? requests[reads++]?.promise
          : undefined,
      );
      const { store, socket } = await initStore();
      const announce = (revision: number, sessionId = "s1") =>
        socket.emit({
          type: "session_projection_changed",
          sessionId,
          revision,
        });
      const projection = (revision: number) => ({
        body: activeSnapshot({
          transcriptPage: {
            revision,
            messages: [{ role: "assistant", content: `revision ${revision}` }],
          },
        }),
      });

      announce(2, "background");
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(0);
      announce(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(1);
      announce(3);
      announce(4);
      socket.emit({ type: "agent_settled", sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(2);

      latest.resolve(projection(revision));
      await vi.advanceTimersByTimeAsync(0);
      const confirmed = revision === 4 ? 4 : 1;
      expect(store.getState().transcriptRevision).toBe(confirmed);
      earlier.resolve(projection(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().transcriptRevision).toBe(confirmed);
      expect(store.getState().messages.at(-1)?.content).toBe(
        revision === 4 ? "revision 4" : undefined,
      );
    },
  );

  it.each(["selection", "disconnect"] as const)(
    "retires a queued projection refresh at the %s boundary",
    async (boundary) => {
      vi.useFakeTimers();
      let calls = 0;
      installStoreRoutes((url) => {
        if (url.startsWith("/api/sessions/open"))
          return { body: activeSnapshot({ sessionId: "s2" }) };
        if (url.startsWith("/api/snapshot")) calls += 1;
      });
      const { store, socket } = await initStore();
      socket.emit({
        type: "session_projection_changed",
        sessionId: "s1",
        revision: 2,
      });
      if (boundary === "selection") await store.openSession("s2");
      else socket.onclose?.();
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toBe(0);
      expect(store.getState().sessionId).toBe(
        boundary === "selection" ? "s2" : "s1",
      );
    },
  );

  it("keeps projection diagnostics through failed refresh and clears them on recovery", async () => {
    vi.useFakeTimers();
    const recovery = deferred<RouteResponse>();
    let snapshots = 0;
    installStoreRoutes((url) => {
      if (!url.startsWith("/api/snapshot")) return;
      snapshots++;
      return snapshots === 1
        ? { status: 503, body: { error: "snapshot unavailable" } }
        : recovery.promise;
    });
    const { store, socket } = await initStore();
    const emit = (
      revision: number,
      health: { status: string; message: string },
    ) =>
      socket.emit({
        type: "session_projection_changed",
        sessionId: "s1",
        revision,
        health,
        conflict: null,
        sessionStatus: { runState: "running" },
      });

    const pending = {
      status: "pending",
      message: "Waiting for Pi to complete its write.",
    };
    emit(1, pending);
    expect(store.getState()).toMatchObject({
      projectionHealth: pending,
      projectionConflict: null,
      errorSeverity: "warning",
      error: pending.message,
    });
    const broken = { status: "error", message: "malformed persisted line" };
    emit(2, broken);
    await vi.advanceTimersByTimeAsync(16);
    expect(snapshots).toBe(1);
    expect(store.getState()).toMatchObject({
      projectionHealth: broken,
      projectionError: broken.message,
      error: broken.message,
    });

    recovery.resolve({
      body: activeSnapshot({
        transcriptPage: { revision: 3, appendFromRevision: 2 },
      }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState()).toMatchObject({
      transcriptRevision: 3,
      projectionHealth: { status: "ok" },
      projectionError: null,
      error: null,
    });
  });

  it.each([
    ["external-change", { status: "ok" as const }, "warning"],
    [
      "projection-failure",
      { status: "error" as const, message: "damaged projection" },
      "error",
    ],
  ] as const)(
    "keeps %s visible through projection refresh and older paging",
    async (kind, health, severity) => {
      vi.useFakeTimers();
      const conflict = {
        kind,
        message: `${kind} conflict`,
        revision: 3,
        incidentId: "incident-ownership",
      };
      let reads = 0;
      installStoreRoutes((url) => {
        if (url.startsWith("/api/transcript/older"))
          return {
            body: {
              sessionId: "s1",
              viewId: "view-s1",
              incarnation: "projection-1",
              revision: 3,
              messages: [{ role: "user", content: "earlier", timestamp: 1 }],
              hasOlder: false,
              olderCursor: null,
            },
          };
        if (!url.startsWith("/api/snapshot")) return;
        if (++reads === 1)
          return { status: 503, body: { error: "snapshot unavailable" } };
        return {
          body: {
            ...activeSnapshot({
              projectionHealth: health,
              projectionConflict: conflict,
              transcriptPage: {
                revision: 3,
                appendFromRevision: 3,
                messages: [{ role: "user", content: "latest", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "older",
              },
            }),
            runState: "conflict",
          },
        };
      });
      const { store, socket } = await initStore();
      const report = {
        sessionId: "s1",
        conflict,
        sessionStatus: { runState: "conflict" },
      };
      socket.emit({ type: "session_projection_conflict", ...report });
      socket.emit({
        type: "session_projection_changed",
        ...report,
        revision: 2,
        health,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(1);
      expect(store.getState()).toMatchObject({
        error: conflict.message,
        errorSeverity: severity,
      });

      socket.emit({
        type: "session_projection_changed",
        ...report,
        revision: 3,
        health,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(store.getState()).toMatchObject({
        transcriptRevision: 3,
        projectionHealth: health,
        projectionConflict: conflict,
        runState: "conflict",
        error: conflict.message,
        errorSeverity: severity,
        olderMessagesCursor: "older",
      });
      await expect(store.loadOlderMessages()).resolves.toBe(true);
      expect(store.getState()).toMatchObject({
        messages: [{ content: "earlier" }, { content: "latest" }],
        projectionError: conflict.message,
        error: conflict.message,
      });
    },
  );

  it("clears Pending without replacing newer queue events with a receipt", async () => {
    const clear = deferred<RouteResponse>();
    const fetch = installStoreRoutes((url) =>
      url === "/api/pending/clear" ? clear.promise : undefined,
    );
    const { store, socket } = await initStore();
    const active = activeSnapshot();
    active.pendingQueues = pendingQueues(["one"]);
    socket.emit({ type: "snapshot", data: active });
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
