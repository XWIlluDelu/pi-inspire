// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../src/api";
import {
  emptyWorkspaceBrowserState,
  type WorkspaceBrowserState,
  WorkspaceController,
} from "../../src/controllers/workspace-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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

describe("WorkspaceController", () => {
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

  it("clears stale projections on transport replacement and reports auth expiry", async () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: { "": [{ name: "old", type: "file" }] },
      workspaceQuery: "old",
      workspaceMatches: [{ name: "old", path: "old" }],
    });
    harness.replaceTransport();
    harness.controller.invalidateForTransportReplacement();
    expect(harness.state()).toMatchObject(emptyWorkspaceBrowserState());

    harness.listFiles.mockRejectedValue(new ApiError(401, "Unauthorized"));
    await harness.controller.loadDirectory("");
    expect(harness.handleAuthFailure).toHaveBeenCalledTimes(1);
  });
});
