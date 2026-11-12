// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTP_OBSERVATION_TIMEOUT_MS } from "../../src/api";
import {
  activeSnapshot,
  bootstrapPayload,
  branchTree,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("completion-driven Pi operation observation", () => {
  it("observes native export and navigation through five minutes of extension work", async () => {
    const exporting = deferred<RouteResponse>();
    const navigation = deferred<RouteResponse>();
    const exportPath = "/api/control/native-command";
    const navigatePath = "/api/branches/navigate";
    const fetch = installStoreRoutes((url) => {
      if (url === exportPath) return exporting.promise;
      if (url === navigatePath) return navigation.promise;
      if (url.startsWith("/api/branches/tree")) return { body: branchTree() };
    });
    const { store, socket } = await initStore();
    await store.loadBranchTree();
    await store.sendPrompt("/export");
    const navigating = store.navigateBranch("u1", "edit");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.emit({ type: "heartbeat" });
    }
    expect(store.getState()).toMatchObject({
      connection: "open",
      branchActionId: "edit:u1",
      branchTreeError: null,
      commandActivities: {
        s1: [expect.objectContaining({ status: "running" })],
      },
    });

    exporting.resolve({
      body: {
        command: "export",
        outcome: "completed",
        message: "Pi completed",
        details: [{ label: "Path", value: "/tmp/export.html" }],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      status: "success",
      message: "Pi completed",
      action: { kind: "copy", value: "/tmp/export.html" },
    });

    navigation.resolve({
      body: {
        snapshot: activeSnapshot({
          transcriptPage: { viewId: "navigated-view" },
        }),
        editorText: "Returned editor text",
      },
    });
    await expect(navigating).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      transcriptViewId: "navigated-view",
      editorText: { text: "Returned editor text" },
      branchActionId: null,
    });
    expect(
      fetch.mock.calls
        .map(([url]) => url)
        .filter((url) => url === exportPath || url === navigatePath),
    ).toEqual([exportPath, navigatePath]);
  });

  it("keeps a replacement graphical export pending when the retired download completes", async () => {
    const retired = deferred<RouteResponse>();
    const current = deferred<RouteResponse>();
    const downloading = deferred<void>();
    installStoreRoutes((url, init) => {
      if (url === "/api/sessions/export") {
        return jsonBody(init).format === "html"
          ? { body: { downloadId: "old", fileName: "history.html" } }
          : current.promise;
      }
      if (url === "/api/sessions/s1/exports/old") {
        downloading.resolve();
        return retired.promise;
      }
    });
    const { store } = await initStore();
    const old = expect(store.exportSession("s1", "html")).rejects.toThrow(
      "Host connection changed",
    );
    await downloading.promise;
    await store.init();
    const replacement = expect(
      store.exportSession("s1", "jsonl"),
    ).rejects.toThrow("Export storage unavailable");

    retired.resolve({ body: "old history" });
    await old;
    expect(store.getState().exportingSessions).toEqual({ s1: "jsonl" });
    expect(store.getState().notices).toEqual([]);

    current.resolve({
      status: 503,
      body: { error: "Export storage unavailable" },
    });
    await replacement;
    expect(store.getState().exportingSessions).toEqual({});
    expect(store.getState().notices.at(-1)).toMatchObject({
      kind: "error",
      text: "Export storage unavailable",
    });
  });
});

describe("detail snapshots and selection intent", () => {
  it("releases a blackholed open while the socket stays healthy and permits an explicit re-open", async () => {
    const pending = deferred<RouteResponse>();
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    installStoreRoutes((url, init) => {
      if (url === "/api/sessions/open") {
        calls += 1;
        if (calls === 1) {
          signal = init.signal;
          return pending.promise;
        }
        return { body: activeSnapshot({ sessionId: "s2" }) };
      }
    });
    const { store, socket } = await initStore();
    const first = store.openSession("s2");
    await store.openSession("s2");
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    socket.emit({ type: "heartbeat" });
    await vi.advanceTimersByTimeAsync(HTTP_OBSERVATION_TIMEOUT_MS - 30_000);
    await first;
    expect(signal?.aborted).toBe(true);
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      connection: "open",
      sessionSelectionPending: false,
      sessionActionError: expect.stringContaining("could not confirm"),
    });
    await store.openSession("s2");
    expect(calls).toBe(2);
    expect(store.getState().sessionId).toBe("s2");
    pending.resolve({ body: activeSnapshot({ sessionId: "stale" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().sessionId).toBe("s2");
  });

  it("ignores a superseded 401 but retires the current selection on auth loss", async () => {
    const pending = deferred<RouteResponse>();
    let signal: AbortSignal | null | undefined;
    installStoreRoutes((url, init) => {
      if (url === "/api/sessions/open") {
        if (jsonBody(init).id === "s2") {
          signal = init.signal;
          return pending.promise;
        }
        if (jsonBody(init).id === "s4")
          return { status: 401, body: { error: "Current pairing expired" } };
        return { body: activeSnapshot({ sessionId: "s3" }) };
      }
    });
    const { store } = await initStore();
    const first = store.openSession("s2");
    await store.openSession("s3");
    await first;
    expect(signal?.aborted).toBe(true);
    pending.resolve({ status: 401, body: { error: "Stale pairing" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      sessionId: "s3",
      needsToken: false,
      sessionSelectionPending: false,
    });
    await store.openSession("s4");
    expect(store.getState()).toMatchObject({
      needsToken: true,
      sessionSelectionPending: false,
    });
  });

  it("keeps a current HTTP selection through socket close but cancels it on bootstrap replacement", async () => {
    const pending = deferred<RouteResponse>();
    let signal: AbortSignal | null | undefined;
    installStoreRoutes((url, init) => {
      if (url === "/api/sessions/open") {
        signal = init.signal;
        return pending.promise;
      }
    });
    const { store, socket } = await initStore();
    const first = store.openSession("s2");
    socket.onclose?.();
    expect(signal?.aborted).toBe(false);
    await store.init();
    await first;
    expect(signal?.aborted).toBe(true);
    pending.resolve({ status: 401, body: { error: "Old API" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      needsToken: false,
      sessionSelectionPending: false,
    });
  });

  it("requires confirmation only when repeating a creation that may have been accepted", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const timeout = deferred<RouteResponse>();
    const superseded = deferred<RouteResponse>();
    const create = vi
      .fn<() => RouteResponse | Promise<RouteResponse>>()
      .mockReturnValueOnce({
        status: 400,
        body: { error: "Invalid directory" },
      })
      .mockReturnValueOnce(timeout.promise)
      .mockReturnValueOnce({ body: activeSnapshot({ sessionId: "created" }) })
      .mockReturnValueOnce(superseded.promise);
    installStoreRoutes((url) => {
      if (url === "/api/sessions/new") return create();
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "other" }) };
    });
    const { store } = await initStore();
    await expect(store.newSession("/invalid")).resolves.toBeNull();
    const creating = store.newSession("/proj");
    await store.newSession("/proj");
    expect(create).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();

    timeout.resolve({ status: 504, body: { error: "Gateway timed out" } });
    await expect(creating).resolves.toBeNull();
    expect(store.getState().sessionSelectionPending).toBe(false);
    await store.init();
    await store.newSession("/proj");
    expect(create).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("may still complete"),
    );

    confirm.mockReturnValue(true);
    await expect(store.newSession("/proj")).resolves.toBe("created");
    expect(create).toHaveBeenCalledTimes(3);

    confirm.mockClear().mockReturnValue(false);
    const interrupted = store.newSession("/proj");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(4));
    await store.openSession("other");
    await expect(interrupted).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    await store.newSession("/proj");
    expect(create).toHaveBeenCalledTimes(4);
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it.each(["create", "deselect"] as const)(
    "only reopens the current session to supersede a pending %s",
    async (operation) => {
      const retired = deferred<RouteResponse>();
      const reopening = deferred<RouteResponse>();
      let opens = 0;
      let signal: AbortSignal | null | undefined;
      installStoreRoutes((url, init) => {
        if (url === "/api/sessions/new" || url === "/api/sessions/deselect") {
          signal = init.signal;
          return retired.promise;
        }
        if (url === "/api/sessions/open") {
          opens += 1;
          return reopening.promise;
        }
      });
      const { store } = await initStore();
      await store.openSession("s1");
      expect(opens).toBe(0);

      const previous =
        operation === "create"
          ? store.newSession("/proj")
          : store.deselectSession();
      const latest = store.openSession("s1");
      await previous;
      expect(signal?.aborted).toBe(true);
      expect(opens).toBe(1);
      retired.resolve({
        body:
          operation === "create"
            ? activeSnapshot({ sessionId: "stale" })
            : {
                active: null,
                runState: "idle",
                sessionStatuses: {},
              },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({
        sessionId: "s1",
        openingSessionId: "s1",
        sessionSelectionPending: true,
      });
      reopening.resolve({
        body: activeSnapshot({ sessionId: "s1", sessionName: "Reopened" }),
      });
      await latest;
      expect(store.getState()).toMatchObject({
        sessionName: "Reopened",
        openingSessionId: null,
        sessionSelectionPending: false,
      });
    },
  );

  it.each(["open", "deselect"] as const)(
    "keeps a pending %s when the previous detail interest synchronizes",
    async (operation) => {
      const pending = deferred<RouteResponse>();
      installStoreRoutes((url, init) => {
        if (url === "/api/sessions/open") {
          return jsonBody(init).id === "s2"
            ? { body: activeSnapshot({ sessionId: "s2" }) }
            : pending.promise;
        }
        if (url === "/api/sessions/deselect") return pending.promise;
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
});

describe("bootstrap snapshot ownership", () => {
  it("keeps a same-session resync committed while bootstrap was in flight", async () => {
    const bootstrap = deferred<RouteResponse>();
    let reconnecting = false;
    installStoreRoutes((url, init) => {
      if (reconnecting && url.startsWith("/api/bootstrap"))
        return bootstrap.promise;
      if (url === "/api/control/model")
        return {
          body: {
            model: { provider: "provider", id: "new-model" },
            thinkingLevel: "medium",
          },
        };
      if (url.startsWith("/api/snapshot"))
        return {
          body: activeSnapshot({
            model: { provider: "provider", id: "new-model" },
          }),
        };
      if (url === "/api/preferences")
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
    });
    const { store } = await initStore();
    reconnecting = true;
    const initializing = store.init();
    await store.setModel("provider", "new-model");
    bootstrap.resolve({
      body: bootstrapPayload({ snapshot: activeSnapshot() }),
    });
    await initializing;
    expect(store.getState().model).toMatchObject({
      provider: "provider",
      id: "new-model",
    });
  });

  it.each(["new", "deselect"] as const)(
    "keeps a %s selection committed while reconnect bootstrap was in flight",
    async (operation) => {
      const bootstrap = deferred<RouteResponse>();
      let reconnecting = false;
      installStoreRoutes((url) => {
        if (reconnecting && url.startsWith("/api/bootstrap"))
          return bootstrap.promise;
        if (url === "/api/sessions/new")
          return { body: activeSnapshot({ sessionId: "s2" }) };
        if (url === "/api/sessions/deselect")
          return {
            body: { active: null, runState: "idle", sessionStatuses: {} },
          };
      });
      const { store } = await initStore();
      reconnecting = true;
      const initializing = store.init();
      if (operation === "new") await store.newSession("/proj");
      else await store.deselectSession();
      const sessionId = operation === "deselect" ? null : "s2";
      expect(store.getState().sessionId).toBe(sessionId);

      bootstrap.resolve({
        body: bootstrapPayload({ snapshot: activeSnapshot() }),
      });
      await initializing;
      expect(store.getState().sessionId).toBe(sessionId);
      const socket = FakeWebSocket.instances.at(-1)!;
      const url = new URL(socket.url, window.location.href);
      expect(url.searchParams.get("detail")).toBe(sessionId ?? "");
      // The old bootstrap digest cannot attest the retained newer selection.
      expect(url.searchParams.has("snapshot")).toBe(false);
    },
  );
});

describe("runtime control completion ownership", () => {
  it.each(["return-to-session", "same-session-view"] as const)(
    "keeps the current refresh and rejects obsolete control effects after %s",
    async (transition) => {
      const command = deferred<RouteResponse>();
      const abort = deferred<RouteResponse>();
      const sent = deferred<Record<string, unknown>>();
      const snapshot = deferred<RouteResponse>();
      let snapshotReads = 0;
      installStoreRoutes((url, init) => {
        if (url === "/api/control/native-command") return command.promise;
        if (url === "/api/control/abort") {
          sent.resolve(jsonBody(init));
          return abort.promise;
        }
        if (url.startsWith("/api/snapshot")) {
          return ++snapshotReads === 1
            ? snapshot.promise
            : { status: 503, body: { error: "Redundant refresh failed" } };
        }
        if (url === "/api/sessions/open")
          return {
            body: activeSnapshot({ sessionId: String(jsonBody(init).id) }),
          };
      });
      const { store, socket } = await initStore();
      await store.sendPrompt("/compact");
      const stopping = store.abort();
      expect(await sent.promise).toMatchObject({
        sessionId: "s1",
        expectedViewId: "view-s1",
      });
      if (transition === "return-to-session") {
        await store.openSession("s2");
        await store.openSession("s1");
      } else {
        socket.emit({
          type: "snapshot",
          detailSessionId: "s1",
          detailRevision: 0,
          data: activeSnapshot({ transcriptPage: { viewId: "next-view" } }),
        });
      }
      const viewId = store.getState().transcriptViewId!;
      socket.emit({ type: "runtime_ready", sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshotReads).toBe(1);

      abort.resolve({ status: 409, body: { error: "Old abort failed" } });
      await stopping;
      expect(store.getState().notices).toEqual([]);
      command.resolve({
        body: {
          command: "compact",
          outcome: "completed",
          message: "Context compacted.",
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      snapshot.resolve({
        body: activeSnapshot({
          sessionName: "Fresh session",
          transcriptPage: { viewId },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getState()).toMatchObject({
        sessionName: "Fresh session",
        transcriptViewId: viewId,
        error: null,
      });
      expect(snapshotReads).toBe(1);
      expect(store.getState().commandActivities.s1).toBeUndefined();
      expect(store.getState().notices.at(-1)?.text).toBe("Context compacted.");
    },
  );

  it.each([
    ["thinking", "refused"],
    ["model", "refused"],
    ["model", "accepted"],
  ] as const)(
    "keeps the current refresh and settings after an old %s request is %s",
    async (control, outcome) => {
      const previous = deferred<RouteResponse>();
      const current = deferred<RouteResponse>();
      let reads = 0;
      installStoreRoutes((url, init) => {
        if (url === `/api/control/${control}`) return previous.promise;
        if (url.startsWith("/api/snapshot")) {
          reads += 1;
          return current.promise;
        }
        if (url === "/api/sessions/open")
          return {
            body: activeSnapshot({
              sessionId: String(jsonBody(init).id),
              thinkingLevel: "low",
            }),
          };
        if (url === "/api/preferences")
          return {
            body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
          };
      });
      const { store, socket } = await initStore();
      const changing =
        control === "thinking"
          ? store.setThinkingLevel("high")
          : store.setModel("provider", "model");
      await store.openSession("s2");
      if (outcome === "refused") await store.openSession("s1");
      const sessionId = store.getState().sessionId!;
      socket.emit({ type: "runtime_ready", sessionId });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);

      previous.resolve(
        outcome === "refused"
          ? { status: 503, body: { error: "Old settings change failed" } }
          : {
              body: {
                model: { provider: "provider", id: "model" },
                thinkingLevel: "medium",
              },
            },
      );
      await changing;
      expect(store.getState().thinkingLevel).toBe("low");
      expect(store.getState().notices).toEqual([]);
      current.resolve({
        body: activeSnapshot({ sessionId, sessionName: "Fresh session" }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().sessionName).toBe("Fresh session");
      expect(reads).toBe(1);
    },
  );
});

describe("resync failure ownership", () => {
  it.each([
    ["return to session", false],
    ["same-session view", false],
    ["Host selection push", true],
  ] as const)(
    "keeps the current view and its error after an older resync settles across %s",
    async (transition, succeeds) => {
      const pending = deferred<RouteResponse>();
      const fetch = installStoreRoutes((url, init) => {
        if (url.startsWith("/api/snapshot")) return pending.promise;
        if (url === "/api/sessions/open")
          return {
            body: activeSnapshot({ sessionId: String(jsonBody(init).id) }),
          };
      });
      const { store, socket } = await initStore();
      socket.emit({ type: "runtime_ready", sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fetch.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/snapshot"),
        ),
      ).toHaveLength(1);

      const sessionId = succeeds ? "s2" : "s1";
      const viewId =
        transition === "same-session view"
          ? "replacement-view"
          : `view-${sessionId}`;
      const currentError = succeeds ? null : "Current projection failed";
      if (transition === "return to session") {
        await store.openSession("s2");
        await store.openSession("s1");
      }
      socket.emit({
        type: "snapshot",
        ...(transition === "same-session view"
          ? { detailSessionId: "s1", detailRevision: 0 }
          : {}),
        data: activeSnapshot({
          sessionId,
          transcriptPage: {
            viewId,
            messages: [{ role: "assistant", content: "current", timestamp: 2 }],
          },
          ...(currentError
            ? { projectionHealth: { status: "error", message: currentError } }
            : {}),
        }),
      });
      expect(store.getState().error).toBe(currentError);
      pending.resolve(
        succeeds
          ? {
              body: activeSnapshot({
                pageMessages: [
                  { role: "assistant", content: "stale", timestamp: 1 },
                ],
              }),
            }
          : { status: 503, body: { error: "Old snapshot unavailable" } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({
        sessionId,
        transcriptViewId: viewId,
        error: currentError,
        messages: [{ content: "current" }],
      });
    },
  );

  it("keeps confirmed content through quiet retries and warns only on exhaustion", async () => {
    let reads = 0;
    let reachable = false;
    installStoreRoutes((url) => {
      if (!url.startsWith("/api/snapshot")) return;
      reads++;
      return reachable
        ? { body: activeSnapshot({ sessionName: "Reobserved" }) }
        : { status: 503, body: { error: "Snapshot unavailable" } };
    });
    const { store, socket } = await initStore();
    const refresh = () =>
      socket.emit({ type: "runtime_ready", sessionId: "s1" });

    refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ connection: "open", error: null });
    reachable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState()).toMatchObject({
      sessionName: "Reobserved",
      error: null,
      connection: "open",
    });
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(reads).toBe(2);

    reachable = false;
    refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      sessionName: "Reobserved",
      error: null,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(store.getState()).toMatchObject({
      sessionName: "Reobserved",
      error:
        "Could not refresh this conversation. Showing the last loaded version.",
      errorSeverity: "warning",
    });
  });

  it("keeps a same-API 401 transport-wide after navigation", async () => {
    const pending = deferred<RouteResponse>();
    installStoreRoutes((url) => {
      if (url.startsWith("/api/snapshot")) return pending.promise;
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "s2" }) };
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
