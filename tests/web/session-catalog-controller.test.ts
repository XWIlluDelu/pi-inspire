import { describe, expect, it, vi } from "vitest";
import {
  defaultPreferences,
  type SessionSummary,
} from "../../shared/contracts";
import { ApiError, type Api } from "../../src/api";
import {
  SessionCatalogController,
  type SessionCatalogPatch,
  type SessionCatalogState,
} from "../../src/controllers/session-catalog-controller";

function session(id: string): SessionSummary {
  return {
    id,
    title: id,
    cwd: `/workspace/${id}`,
    project: id,
    created: "2026-08-14T00:00:00.000Z",
    modified: "2026-08-14T00:00:00.000Z",
    messageCount: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  let state: SessionCatalogState = {
    sessions: [],
    sessionQuery: "",
    sessionListTotal: 0,
    sessionListNextOffset: 0,
    sessionListLoading: false,
    sessionListLoadingOlder: false,
    sessionListHydrating: false,
    sessionListOperation: null,
    sessionListError: null,
    prefs: defaultPreferences,
    sessionId: null,
    sessionStatuses: {},
  };
  const sessions = vi.fn();
  const sessionsByIds = vi.fn();
  const sessionsByCwds = vi.fn();
  const refreshSessions = vi.fn();
  const api = {
    sessions,
    sessionsByIds,
    sessionsByCwds,
    refreshSessions,
  } as unknown as Api;
  const handleAuthFailure = vi.fn();
  const controller = new SessionCatalogController({
    state: () => state,
    patch: (patch: SessionCatalogPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    confirmedPreferences: () => defaultPreferences,
    handleAuthFailure,
  });
  return {
    controller,
    state: () => state,
    patch: (patch: Partial<SessionCatalogState>) => {
      state = { ...state, ...patch };
    },
    sessions,
    sessionsByIds,
    sessionsByCwds,
    refreshSessions,
    handleAuthFailure,
  };
}

describe("SessionCatalogController", () => {
  it("publishes only the newest query generation", async () => {
    const oldPage = deferred<{
      sessions: SessionSummary[];
      offset: number;
      total: number;
    }>();
    const newPage = deferred<{
      sessions: SessionSummary[];
      offset: number;
      total: number;
    }>();
    const harness = createHarness();
    harness.sessions.mockImplementation((query: string) =>
      query === "old" ? oldPage.promise : newPage.promise,
    );

    const oldLoad = harness.controller.load("old");
    const newLoad = harness.controller.load("new");
    newPage.resolve({ sessions: [session("new")], offset: 0, total: 1 });
    await newLoad;
    oldPage.resolve({ sessions: [session("old")], offset: 0, total: 1 });
    await oldLoad;

    expect(harness.state()).toMatchObject({
      sessionQuery: "new",
      sessions: [session("new")],
      sessionListNextOffset: 1,
    });
  });

  it("hydrates a selected row without advancing the chronological cursor", async () => {
    const harness = createHarness();
    harness.patch({ sessionId: "selected" });
    harness.sessions.mockResolvedValue({ sessions: [], offset: 0, total: 0 });
    harness.sessionsByIds.mockResolvedValue({
      sessions: [session("selected")],
    });

    await harness.controller.load("");

    expect(harness.state()).toMatchObject({
      sessions: [session("selected")],
      sessionListNextOffset: 0,
      sessionListTotal: 0,
    });
  });

  it("cancels a debounced search when its transport is invalidated", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.controller.search("stale transport query");
      harness.controller.invalidate();

      await vi.advanceTimersByTimeAsync(200);

      expect(harness.sessions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a new generation hydrate an id while the invalidated request is still pending", async () => {
    const oldRequest = deferred<{ sessions: SessionSummary[] }>();
    const currentRequest = deferred<{ sessions: SessionSummary[] }>();
    const harness = createHarness();
    harness.patch({ sessionId: "selected" });
    harness.sessionsByIds
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);

    harness.controller.ensureVisible("selected");
    expect(harness.sessionsByIds).toHaveBeenCalledTimes(1);
    harness.controller.invalidate();
    harness.controller.ensureVisible("selected");
    expect(harness.sessionsByIds).toHaveBeenCalledTimes(2);

    oldRequest.resolve({ sessions: [session("stale")] });
    await oldRequest.promise;
    await Promise.resolve();
    harness.controller.ensureVisible("selected");
    expect(harness.sessionsByIds).toHaveBeenCalledTimes(2);

    currentRequest.resolve({ sessions: [session("selected")] });
    await currentRequest.promise;
    await vi.waitFor(() =>
      expect(harness.state().sessions).toEqual([session("selected")]),
    );
  });

  it("does not let an invalidated request turn a newer transport into pairing", async () => {
    const pending = deferred<{
      sessions: SessionSummary[];
      offset: number;
      total: number;
    }>();
    const harness = createHarness();
    harness.sessions.mockReturnValue(pending.promise);

    const loading = harness.controller.load("");
    harness.controller.invalidate();
    pending.reject(new ApiError(401, "old token"));
    await loading;

    expect(harness.handleAuthFailure).not.toHaveBeenCalled();
  });
});
