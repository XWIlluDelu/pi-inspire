// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api";
import {
  emptyWorkspaceBrowserState,
  WorkspaceController,
  type WorkspaceBrowserPatch,
  type WorkspaceControllerState,
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
  let state: WorkspaceControllerState = {
    sessionId: "s1",
    cwd: "/project",
    ...emptyWorkspaceBrowserState(),
  };
  const listFiles = vi.fn();
  const searchFiles = vi.fn();
  const api = { listFiles, searchFiles } as unknown as Api;
  const controller = new WorkspaceController({
    state: () => state,
    patch: (patch: WorkspaceBrowserPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => transportGeneration,
  });
  return {
    controller,
    state: () => state,
    patch: (patch: Partial<WorkspaceControllerState>) => {
      state = { ...state, ...patch };
    },
    listFiles,
    searchFiles,
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

  it("drops a directory result after its workspace owner changes", async () => {
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

  it("publishes only the newest shared search", async () => {
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

  it("reveals every ancestor and refreshes the expanded tree from one new index", async () => {
    const harness = createHarness();
    harness.listFiles.mockResolvedValue({ entries: [] });

    harness.controller.revealPath("src/components/App.tsx");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.state()).toMatchObject({
      workspaceExpandedDirs: ["src", "src/components"],
      workspaceSelectedPath: "src/components/App.tsx",
    });
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

  it("clears stale projections when the transport is replaced", async () => {
    const harness = createHarness();
    harness.patch({
      workspaceLevels: { "": [{ name: "old", type: "file" }] },
      workspaceQuery: "old",
      workspaceMatches: [{ name: "old", path: "old" }],
    });
    harness.replaceTransport();

    harness.controller.invalidateForTransportReplacement();

    expect(harness.state()).toMatchObject(emptyWorkspaceBrowserState());
  });
});
