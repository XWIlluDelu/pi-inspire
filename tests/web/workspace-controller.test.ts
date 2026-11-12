// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../src/api";
import {
  emptyWorkspaceBrowserState,
  type WorkspaceBrowserState,
  WorkspaceController,
} from "../../src/controllers/workspace-controller";
import { deferred } from "./helpers";

function createHarness() {
  let state = {
    sessionId: "s1" as string | null,
    cwd: "/project" as string | null,
    ...emptyWorkspaceBrowserState(),
  };
  const listFiles = vi.fn();
  const searchFiles = vi.fn();
  const handleAuthFailure = vi.fn();
  let api = { listFiles, searchFiles } as unknown as Api;
  const controller = new WorkspaceController({
    state: () => state,
    patch: (patch: Partial<WorkspaceBrowserState>) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    handleAuthFailure,
  });
  return {
    controller,
    state: () => state,
    patch: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    },
    listFiles,
    searchFiles,
    handleAuthFailure,
    replaceTransport: () => {
      api = { ...api };
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("WorkspaceController", () => {
  it("retires directory and search observations when hidden visibility changes", async () => {
    const harness = createHarness();
    const oldDirectory = deferred<{
      entries: Array<{ name: string; type: "file" }>;
    }>();
    const oldSearch = deferred<{
      files: Array<{ name: string; path: string }>;
    }>();
    harness.listFiles
      .mockReturnValueOnce(oldDirectory.promise)
      .mockResolvedValue({
        entries: [{ name: ".env", type: "file" }],
        truncated: true,
      });
    harness.searchFiles
      .mockReturnValueOnce(oldSearch.promise)
      .mockResolvedValue({
        files: [{ name: ".env", path: ".env" }],
        truncated: true,
      });
    const first = harness.controller.loadDirectory("");
    harness.controller.setQuery("env");
    harness.controller.setShowHidden(true);
    await vi.waitFor(() =>
      expect(harness.state().workspaceMatches[0]?.path).toBe(".env"),
    );
    expect(harness.listFiles.mock.lastCall?.[2]).toMatchObject({
      showHidden: true,
    });
    expect(harness.searchFiles.mock.lastCall?.[4]).toBe(true);
    oldDirectory.resolve({ entries: [{ name: "stale", type: "file" }] });
    oldSearch.resolve({ files: [{ name: "stale", path: "stale" }] });
    await first;
    expect(harness.state()).toMatchObject({
      workspaceShowHidden: true,
      workspaceTruncatedDirs: { "": true },
      workspaceSearchTruncated: true,
      workspaceLevels: { "": [{ name: ".env", type: "file" }] },
      workspaceMatches: [{ name: ".env", path: ".env" }],
    });
    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    expect(harness.state().workspaceShowHidden).toBe(false);
  });

  it("retires the old read on workspace change and restores the saved disclosure and search on return", async () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: {
        "": [{ name: "src", type: "dir" }],
        src: [{ name: "main.ts", type: "file" }],
      },
      workspaceExpandedDirs: ["src"],
      workspaceShowHidden: true,
      workspaceQuery: "main",
      workspaceMatches: [{ name: "main.ts", path: "src/main.ts" }],
    });

    const pending = deferred<Awaited<ReturnType<Api["listFiles"]>>>();
    harness.listFiles.mockReturnValueOnce(pending.promise);
    const load = harness.controller.loadDirectory("retired");
    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    pending.resolve({ entries: [{ name: "stale.txt", type: "file" }] });
    await load;
    expect(harness.state()).toMatchObject(emptyWorkspaceBrowserState());
    harness.patch({ workspaceExpandedDirs: ["docs"] });
    for (let index = 1; index <= 7; index++) {
      const cwd = `/project-${index}`;
      harness.patch({
        sessionId: `s-${index}`,
        cwd,
        ...harness.controller.changeOwner(cwd),
      });
    }

    const restored = harness.controller.changeOwner("/project");
    harness.patch({ sessionId: "s1", cwd: "/project", ...restored });
    expect(harness.state()).toMatchObject({
      workspaceExpandedDirs: ["src"],
      workspaceShowHidden: true,
      workspaceQuery: "main",
      workspaceMatches: [{ name: "main.ts", path: "src/main.ts" }],
    });
  });

  it("publishes only the newest search", async () => {
    const first = deferred<{ files: Array<{ name: string; path: string }> }>();
    const second = deferred<{ files: Array<{ name: string; path: string }> }>();
    const harness = createHarness();
    harness.searchFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    harness.controller.setQuery("old");
    harness.controller.setQuery("new");
    second.resolve({ files: [{ name: "new.ts", path: "src/new.ts" }] });
    await second.promise;
    await Promise.resolve();
    first.resolve({ files: [{ name: "old.ts", path: "src/old.ts" }] });
    await first.promise;
    await Promise.resolve();

    expect(harness.state()).toMatchObject({
      workspaceQuery: "new",
      workspaceMatches: [{ name: "new.ts", path: "src/new.ts" }],
      workspaceSearchLoading: false,
    });
  });

  it("shares directory reads, reveals each ancestor and refreshes only the current tree", async () => {
    const harness = createHarness();
    harness.listFiles.mockResolvedValue({ entries: [] });

    await Promise.all([
      harness.controller.loadDirectory(""),
      harness.controller.loadDirectory(""),
    ]);
    harness.controller.revealPath("src/components/App.tsx");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state().workspaceExpandedDirs).toEqual([
      "src",
      "src/components",
    ]);
    const reveal = harness.state().workspaceRevealRequest!;
    expect(reveal.path).toBe("src/components/App.tsx");
    expect(harness.controller.consumeRevealRequest(reveal.nonce)).toBe(true);
    expect(harness.state().workspaceRevealRequest).toBeNull();
    expect(harness.listFiles.mock.calls.map((call) => call[1])).toEqual([
      "",
      "src",
      "src/components",
    ]);

    const first = deferred<Awaited<ReturnType<Api["listFiles"]>>>();
    const second = deferred<Awaited<ReturnType<Api["listFiles"]>>>();
    harness.listFiles
      .mockClear()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({ entries: [] });

    const staleRefresh = harness.controller.refresh();
    const currentRefresh = harness.controller.refresh();
    first.resolve({ entries: [{ name: "stale", type: "file" }] });
    await first.promise;
    await Promise.resolve();

    expect(harness.listFiles.mock.calls.map((call) => call[1])).toEqual([
      "",
      "",
    ]);

    second.resolve({ entries: [] });
    await Promise.all([staleRefresh, currentRefresh]);
    expect(harness.listFiles.mock.calls.map((call) => call[1])).toEqual([
      "",
      "",
      "src",
      "src/components",
    ]);
    expect(harness.listFiles.mock.lastCall?.[2]).toMatchObject({
      refresh: true,
    });
  });

  it("retires a pending query retry when an overlapping refresh starts its search", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const root = deferred<{ entries: [] }>();
    harness.patch({ workspaceQuery: "file" });
    harness.listFiles.mockReturnValueOnce(root.promise);
    harness.searchFiles
      .mockRejectedValueOnce(new ApiError(503, "temporary"))
      .mockResolvedValue({
        files: [{ name: "current.ts", path: "current.ts" }],
      });
    const refreshing = harness.controller.refresh();
    harness.controller.setQuery("file");
    await vi.advanceTimersByTimeAsync(0);
    const oldRequest = harness.searchFiles.mock.calls[0][3] as AbortSignal;

    root.resolve({ entries: [] });
    await refreshing;
    expect(oldRequest.aborted).toBe(true);
    expect(harness.searchFiles).toHaveBeenCalledTimes(2);
    expect(harness.state()).toMatchObject({
      workspaceMatches: [{ name: "current.ts", path: "current.ts" }],
      workspaceSearchLoading: false,
      workspaceSearchError: null,
    });
  });

  it("recovers transient directory failures and resumes an exhausted search on return", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const unavailable = new ApiError(503, "temporarily unavailable");
    const entries = [{ name: "file.ts", type: "file" }];
    harness.patch({ workspaceQuery: "file" });
    harness.listFiles.mockRejectedValueOnce(unavailable).mockResolvedValue({
      entries,
    });
    harness.searchFiles.mockRejectedValue(unavailable);

    const refreshing = harness.controller.refresh();
    await vi.runAllTimersAsync();
    await refreshing;
    expect(harness.state()).toMatchObject({
      workspaceLevels: { "": entries },
      workspaceLoadingDirs: [],
      workspaceDirectoryErrors: {},
      workspaceSearchLoading: false,
      workspaceSearchError: unavailable.message,
    });

    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    const returning = harness.controller.changeOwner("/project");
    harness.patch({ sessionId: "s1", cwd: "/project", ...returning });
    const files = [{ name: "file.ts", path: "file.ts" }];
    harness.searchFiles.mockRejectedValueOnce(unavailable).mockResolvedValue({
      files,
    });
    harness.controller.resumeSearch();
    await vi.runAllTimersAsync();
    expect(harness.state()).toMatchObject({
      workspaceMatches: files,
      workspaceSearchLoading: false,
      workspaceSearchError: null,
    });
  });

  it("retires queued retries on workspace, visibility, query and transport replacement", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.listFiles.mockRejectedValue(new ApiError(503, "temporary"));
    harness.searchFiles.mockRejectedValue(new ApiError(503, "temporary"));
    const oldRoot = harness.controller.loadDirectory("");
    harness.controller.setQuery("old");
    await vi.advanceTimersByTimeAsync(0);
    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    await oldRoot;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.listFiles).toHaveBeenCalledTimes(1);
    expect(harness.searchFiles).toHaveBeenCalledTimes(1);

    const hiddenRoot = harness.controller.loadDirectory("");
    harness.controller.setQuery("hidden");
    await vi.advanceTimersByTimeAsync(0);
    harness.listFiles.mockResolvedValue({ entries: [] });
    harness.searchFiles.mockResolvedValue({ files: [] });
    harness.controller.setShowHidden(true);
    await hiddenRoot;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.listFiles).toHaveBeenCalledTimes(3);
    expect(harness.searchFiles).toHaveBeenCalledTimes(3);

    harness.searchFiles.mockRejectedValueOnce(new ApiError(503, "old query"));
    harness.controller.setQuery("old");
    await vi.advanceTimersByTimeAsync(0);
    harness.controller.setQuery("new");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.searchFiles).toHaveBeenCalledTimes(5);

    harness.listFiles.mockRejectedValue(new ApiError(503, "old transport"));
    const oldTransport = harness.controller.loadDirectory("src");
    await vi.advanceTimersByTimeAsync(0);
    harness.replaceTransport();
    harness.controller.invalidateForTransportReplacement();
    await oldTransport;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.listFiles).toHaveBeenCalledTimes(4);
    expect(harness.state()).toMatchObject({
      ...emptyWorkspaceBrowserState(),
      workspaceShowHidden: true,
      workspaceQuery: "new",
      workspaceSearchLoading: true,
    });
  });

  it("clears stale projections but retains navigation on transport replacement and reports auth expiry", async () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: { "": [{ name: "old", type: "file" }] },
      workspaceQuery: "old",
      workspaceMatches: [{ name: "old", path: "old" }],
      workspaceExpandedDirs: ["src"],
      workspaceShowHidden: true,
    });
    harness.replaceTransport();
    harness.controller.invalidateForTransportReplacement();
    expect(harness.state()).toMatchObject({
      ...emptyWorkspaceBrowserState(),
      workspaceQuery: "old",
      workspaceSearchLoading: true,
      workspaceExpandedDirs: ["src"],
      workspaceShowHidden: true,
    });

    harness.listFiles.mockRejectedValue(new ApiError(401, "Unauthorized"));
    await harness.controller.loadDirectory("");
    expect(harness.handleAuthFailure).toHaveBeenCalledTimes(1);
  });
});
