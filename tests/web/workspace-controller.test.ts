// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDirEntry } from "../../shared/contracts";
import { type Api, ApiError } from "../../src/api";
import {
  emptyWorkspaceBrowserState,
  type WorkspaceBrowserState,
  WorkspaceController,
} from "../../src/controllers/workspace-controller";
import { deferred } from "./helpers";

type Directory = { entries: ProjectDirEntry[]; truncated?: boolean };

function createHarness() {
  let state = {
    sessionId: "s1" as string | null,
    cwd: "/project" as string | null,
    ...emptyWorkspaceBrowserState(),
  };
  const listFiles = vi.fn();
  const searchFiles = vi.fn();
  const handleAuthFailure = vi.fn();
  let api = {
    json: (
      name: "listFiles" | "searchFiles",
      input: unknown,
      signal?: AbortSignal,
    ) => ({ listFiles, searchFiles })[name](input, signal),
  } as unknown as Api;
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
    expect(harness.listFiles.mock.lastCall?.[0].query).toMatchObject({
      showHidden: "1",
    });
    expect(harness.searchFiles.mock.lastCall?.[0].query.showHidden).toBe("1");
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

    const pending = deferred<Directory>();
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
    expect(
      harness.listFiles.mock.calls.map(([{ query }]) => query.dir),
    ).toEqual(["", "src", "src/components"]);

    const first = deferred<Directory>();
    const second = deferred<Directory>();
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

    expect(
      harness.listFiles.mock.calls.map(([{ query }]) => query.dir),
    ).toEqual(["", ""]);

    second.resolve({ entries: [] });
    await Promise.all([staleRefresh, currentRefresh]);
    expect(
      harness.listFiles.mock.calls.map(([{ query }]) => query.dir),
    ).toEqual(["", "", "src", "src/components"]);
    expect(harness.listFiles.mock.lastCall?.[0].query).toMatchObject({
      refresh: "1",
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
