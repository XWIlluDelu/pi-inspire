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
  let transportGeneration = 1;
  let state = {
    sessionId: "s1" as string | null,
    cwd: "/project" as string | null,
    ...emptyWorkspaceBrowserState(),
  };
  const listFiles = vi.fn();
  const searchFiles = vi.fn();
  const handleAuthFailure = vi.fn();
  const api = { listFiles, searchFiles } as unknown as Api;
  const controller = new WorkspaceController({
    state: () => state,
    patch: (patch: Partial<WorkspaceBrowserState>) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => transportGeneration,
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
      transportGeneration += 1;
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
    expect(harness.controller.changeOwner("/project").workspaceShowHidden).toBe(
      true,
    );
  });

  it("shares and reuses one directory projection", async () => {
    const harness = createHarness();
    harness.listFiles.mockResolvedValue({
      entries: [{ name: "src", type: "dir" }],
    });

    await Promise.all([
      harness.controller.loadDirectory(""),
      harness.controller.loadDirectory(""),
    ]);
    await harness.controller.loadDirectory("");

    expect(harness.listFiles).toHaveBeenCalledTimes(1);
    expect(harness.state().workspaceLevels[""]).toEqual([
      { name: "src", type: "dir" },
    ]);
  });

  it("drops directory results after workspace ownership changes", async () => {
    const pending = deferred<{
      entries: Array<{ name: string; type: "file" }>;
    }>();
    const harness = createHarness();
    harness.listFiles.mockReturnValue(pending.promise);

    const load = harness.controller.loadDirectory("");
    harness.patch({ sessionId: "s2", cwd: "/other" });
    pending.resolve({ entries: [{ name: "stale.txt", type: "file" }] });
    await load;

    expect(harness.state().workspaceLevels).toEqual({});
  });

  it("restores disclosure and search state per workspace", () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: {
        "": [{ name: "src", type: "dir" }],
        src: [{ name: "main.ts", type: "file" }],
      },
      workspaceExpandedDirs: ["src"],
      workspaceQuery: "main",
      workspaceMatches: [{ name: "main.ts", path: "src/main.ts" }],
    });

    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    expect(harness.state()).toMatchObject(emptyWorkspaceBrowserState());
    harness.patch({ workspaceExpandedDirs: ["docs"] });

    const restored = harness.controller.changeOwner("/project");
    harness.patch({ sessionId: "s1", cwd: "/project", ...restored });
    expect(harness.state()).toMatchObject({
      workspaceExpandedDirs: ["src"],
      workspaceQuery: "main",
      workspaceMatches: [{ name: "main.ts", path: "src/main.ts" }],
    });
  });

  it("restores an oldest cached workspace before saving into a full LRU", () => {
    const harness = createHarness();
    let next = harness.controller.changeOwner("/target");
    harness.patch({ sessionId: "target", cwd: "/target", ...next });
    harness.patch({ workspaceQuery: "remember me" });

    for (let index = 1; index <= 8; index += 1) {
      const cwd = `/project-${index}`;
      next = harness.controller.changeOwner(cwd);
      harness.patch({ sessionId: `s-${index}`, cwd, ...next });
    }

    next = harness.controller.changeOwner("/target");
    expect(next.workspaceQuery).toBe("remember me");
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

  it("reveals every ancestor and refreshes the expanded tree", async () => {
    const harness = createHarness();
    harness.listFiles.mockResolvedValue({ entries: [] });

    harness.controller.revealPath("src/components/App.tsx");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state().workspaceExpandedDirs).toEqual([
      "src",
      "src/components",
    ]);
    expect(harness.state().workspaceRevealRequest).toEqual({
      path: "src/components/App.tsx",
      nonce: 1,
    });
    expect(harness.controller.consumeRevealRequest(0)).toBe(false);
    expect(harness.state().workspaceRevealRequest).not.toBeNull();
    expect(harness.controller.consumeRevealRequest(1)).toBe(true);
    expect(harness.controller.consumeRevealRequest(1)).toBe(false);
    expect(harness.state().workspaceRevealRequest).toBeNull();
    expect(harness.listFiles.mock.calls.map((call) => call[1])).toEqual([
      "",
      "src",
      "src/components",
    ]);

    harness.listFiles.mockClear();
    await harness.controller.refresh();
    expect(harness.listFiles.mock.calls.map((call) => call[1])).toEqual([
      "",
      "src",
      "src/components",
    ]);
    expect(harness.listFiles.mock.calls[0]?.[2]).toMatchObject({
      refresh: true,
    });
  });

  it("lets only the newest refresh continue into expanded levels", async () => {
    const first = deferred<{
      entries: Array<{ name: string; type: "file" }>;
    }>();
    const second = deferred<{
      entries: Array<{ name: string; type: "file" }>;
    }>();
    const harness = createHarness();
    harness.patch({ workspaceExpandedDirs: ["src"] });
    harness.listFiles
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
    ]);
  });

  it("retains the tree and search while refreshing through transient failures", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.patch({
      workspaceLevels: {
        "": [{ name: "src", type: "dir" }],
        src: [{ name: "old.ts", type: "file" }],
      },
      workspaceExpandedDirs: ["src"],
      workspaceQuery: "file",
      workspaceMatches: [{ name: "old.ts", path: "src/old.ts" }],
    });
    harness.listFiles
      .mockRejectedValueOnce(new ApiError(503, "temporarily unavailable"))
      .mockResolvedValueOnce({ entries: [{ name: "src", type: "dir" }] })
      .mockResolvedValueOnce({ entries: [{ name: "new.ts", type: "file" }] });
    harness.searchFiles
      .mockRejectedValueOnce(new ApiError(503, "temporarily unavailable"))
      .mockResolvedValue({ files: [{ name: "new.ts", path: "src/new.ts" }] });

    const refreshing = harness.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state()).toMatchObject({
      workspaceLevels: {
        "": [{ name: "src", type: "dir" }],
        src: [{ name: "old.ts", type: "file" }],
      },
      workspaceMatches: [{ name: "old.ts", path: "src/old.ts" }],
      workspaceDirectoryErrors: {},
      workspaceSearchError: null,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.state()).toMatchObject({
      workspaceLevels: { src: [{ name: "new.ts", type: "file" }] },
      workspaceMatches: [{ name: "old.ts", path: "src/old.ts" }],
      workspaceSearchLoading: true,
      workspaceSearchError: null,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await refreshing;
    expect(harness.state()).toMatchObject({
      workspaceMatches: [{ name: "new.ts", path: "src/new.ts" }],
      workspaceLoadingDirs: [],
      workspaceSearchLoading: false,
      workspaceDirectoryErrors: {},
      workspaceSearchError: null,
    });
    expect(harness.listFiles).toHaveBeenCalledTimes(3);
    expect(harness.searchFiles).toHaveBeenCalledTimes(2);
  });

  it("bounds recovery and resumes an exhausted cached search when returning", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.patch({
      workspaceQuery: "file",
      workspaceMatches: [{ name: "old.ts", path: "old.ts" }],
    });
    harness.searchFiles.mockRejectedValue(
      new ApiError(503, "still unavailable"),
    );
    harness.controller.setQuery("file");
    for (const delay of [0, 1_000, 3_000, 10_000])
      await vi.advanceTimersByTimeAsync(delay);
    expect(harness.searchFiles).toHaveBeenCalledTimes(4);
    expect(harness.state()).toMatchObject({
      workspaceMatches: [{ name: "old.ts", path: "old.ts" }],
      workspaceSearchLoading: false,
      workspaceSearchError: "still unavailable",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.searchFiles).toHaveBeenCalledTimes(4);

    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    const returning = harness.controller.changeOwner("/project");
    harness.patch({ sessionId: "s1", cwd: "/project", ...returning });
    harness.searchFiles.mockResolvedValue({
      files: [{ name: "new.ts", path: "new.ts" }],
    });
    harness.controller.resumeSearch();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state()).toMatchObject({
      workspaceMatches: [{ name: "new.ts", path: "new.ts" }],
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

  it("keeps a failed directory refresh visible and lets a new visit revalidate it", async () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: { "": [{ name: "known.ts", type: "file" }] },
    });
    harness.listFiles.mockRejectedValueOnce(
      new ApiError(403, "Permission denied"),
    );
    await harness.controller.loadDirectory("", { refresh: true });
    expect(harness.listFiles).toHaveBeenCalledTimes(1);
    expect(harness.state()).toMatchObject({
      workspaceLevels: { "": [{ name: "known.ts", type: "file" }] },
      workspaceDirectoryErrors: { "": "Permission denied" },
    });
    const other = harness.controller.changeOwner("/other");
    harness.patch({ sessionId: "s2", cwd: "/other", ...other });
    const returning = harness.controller.changeOwner("/project");
    harness.patch({ sessionId: "s1", cwd: "/project", ...returning });
    harness.listFiles.mockResolvedValue({
      entries: [{ name: "new.ts", type: "file" }],
    });
    await harness.controller.loadDirectory("");
    expect(harness.state()).toMatchObject({
      workspaceLevels: { "": [{ name: "new.ts", type: "file" }] },
      workspaceDirectoryErrors: {},
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
