import { describe, expect, it, vi } from "vitest";
import {
  defaultPreferences,
  type SessionSummary,
} from "../../shared/contracts";
import { type Api, ApiError } from "../../src/api";
import {
  SessionCatalogController,
  type SessionCatalogPatch,
  type SessionCatalogState,
} from "../../src/controllers/session-catalog-controller";
import { deferred } from "./helpers";

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
  it("keeps confirmed catalog rows and foreground loading separate during background preservation", async () => {
    const harness = createHarness();
    harness.sessions.mockResolvedValue({
      sessions: [session("confirmed")],
      offset: 0,
      total: 1,
    });
    await harness.controller.load("");
    const pending = deferred<{
      sessions: SessionSummary[];
      offset: number;
      total: number;
    }>();
    harness.sessions.mockReturnValue(pending.promise);
    const refreshing = harness.controller.refreshLoaded();
    expect(harness.state()).toMatchObject({
      sessions: [session("confirmed")],
      sessionListLoading: false,
      sessionListOperation: null,
    });
    pending.resolve({ sessions: [session("confirmed")], offset: 0, total: 1 });
    await refreshing;
    harness.controller.invalidate();
  });

  it("silently retries a live row while its catalog record materializes", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.patch({ sessionId: "materializing" });
      harness.sessionsByIds
        .mockResolvedValueOnce({ sessions: [] })
        .mockResolvedValue({ sessions: [session("materializing")] });
      harness.controller.ensureVisible("materializing");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state()).toMatchObject({
        sessionListError: null,
        sessionListOperation: null,
        sessions: [],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.state().sessions).toEqual([session("materializing")]);
      expect(harness.state().sessionListNextOffset).toBe(0);
      expect(harness.sessionsByIds).toHaveBeenCalledTimes(2);
      harness.controller.invalidate();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds absent live-row lookups and retires their recovery with the catalog generation", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.patch({ sessionId: "absent" });
      harness.sessionsByIds.mockResolvedValue({ sessions: [] });
      harness.controller.ensureVisible("absent");
      await vi.advanceTimersByTimeAsync(14_000);
      expect(harness.sessionsByIds).toHaveBeenCalledTimes(4);
      expect(harness.state().sessionListError).toBeNull();
      harness.controller.invalidate();
      harness.controller.ensureVisible("absent");
      await vi.advanceTimersByTimeAsync(0);
      harness.controller.invalidate();
      await vi.advanceTimersByTimeAsync(14_000);
      expect(harness.sessionsByIds).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps available rows and source diagnostics separate from transport errors, then clears diagnostics on recovery", async () => {
    const harness = createHarness();
    harness.sessionsByIds.mockResolvedValue({ sessions: [] });
    harness.sessionsByCwds.mockResolvedValue({ sessions: [] });
    harness.sessions.mockResolvedValueOnce({
      sessions: [session("healthy")],
      offset: 0,
      total: 1,
      issues: [{ path: "/offline", message: "Access denied" }],
    });
    await harness.controller.load("");
    expect(harness.state()).toMatchObject({
      sessions: [{ id: "healthy" }],
      sessionListTotal: 1,
      sessionListNextOffset: 1,
      sessionListError: null,
      sessionListIssues: [{ path: "/offline" }],
    });
    harness.sessions.mockResolvedValueOnce({
      sessions: [session("healthy"), session("recovered")],
      offset: 0,
      total: 2,
    });
    await harness.controller.refresh();
    expect(harness.refreshSessions).toHaveBeenCalledOnce();
    expect(harness.state()).toMatchObject({
      sessions: [{ id: "healthy" }, { id: "recovered" }],
      sessionListIssues: [],
    });
  });
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
    const oldQuery = 'token "body phrase"';
    const newQuery = "re:Assistant-[A-Z]+";
    const signals: AbortSignal[] = [];
    harness.sessions.mockImplementation(
      (query: string, _offset: number, _limit: number, signal: AbortSignal) => {
        signals.push(signal);
        return query === oldQuery ? oldPage.promise : newPage.promise;
      },
    );

    const oldLoad = harness.controller.load(oldQuery);
    const newLoad = harness.controller.load(newQuery);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    newPage.resolve({ sessions: [session("new")], offset: 0, total: 1 });
    await newLoad;
    oldPage.resolve({ sessions: [session("old")], offset: 0, total: 1 });
    await oldLoad;

    expect(harness.state()).toMatchObject({
      sessionQuery: newQuery,
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
