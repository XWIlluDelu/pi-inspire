import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatusResponse } from "../../shared/contracts";
import type { Api } from "../../src/api";
import {
  GitController,
  type GitControllerPatch,
  type GitControllerState,
} from "../../src/controllers/git-controller";

const notRepository: GitStatusResponse = { kind: "not-repository" };

function createHarness(initial: Partial<GitControllerState> = {}) {
  let state: GitControllerState = {
    sessionId: "s1",
    selectionGeneration: 1,
    resourcesOpen: false,
    contextMode: "files",
    detailMode: "file",
    gitStatus: null,
    gitStatusError: null,
    gitStatusLoading: false,
    gitStatusRefreshing: false,
    selectedGitPathId: null,
    selectedGitSide: null,
    gitDiff: null,
    ...initial,
  };
  const gitStatus = vi.fn();
  const gitDiff = vi.fn();
  const api = { gitStatus, gitDiff } as unknown as Api;
  const cancelResourcePreview = vi.fn();
  const openResourceFromGit = vi.fn<(path: string) => Promise<void>>();
  const controller = new GitController({
    state: () => state,
    patch: (patch: GitControllerPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => 1,
    cancelResourcePreview,
    openResourceFromGit,
  });
  return {
    controller,
    state: () => state,
    patch: (patch: Partial<GitControllerState>) => {
      state = { ...state, ...patch };
    },
    gitStatus,
    gitDiff,
    cancelResourcePreview,
    openResourceFromGit,
  };
}

describe("GitController", () => {
  afterEach(() => vi.useRealTimers());

  it("does not publish a status response after its selection generation changes", async () => {
    let resolve!: (status: GitStatusResponse) => void;
    const pending = new Promise<GitStatusResponse>((complete) => {
      resolve = complete;
    });
    const harness = createHarness();
    harness.gitStatus.mockReturnValue(pending);

    const refresh = harness.controller.refreshStatus();
    harness.patch({ selectionGeneration: 2, sessionId: "s2" });
    resolve(notRepository);
    await refresh;

    expect(harness.state()).toMatchObject({
      sessionId: "s2",
      gitStatus: null,
      gitStatusError: null,
    });
  });

  it("polls only while a Git surface remains visible", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.gitStatus.mockResolvedValue(notRepository);

    harness.controller.setSurfaceVisible("test", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(2);

    harness.controller.setSurfaceVisible("test", false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(2);
  });

  it("clears Git selection only when a Files resource replaces it", () => {
    const selected: GitControllerState = {
      sessionId: "s1",
      selectionGeneration: 1,
      resourcesOpen: true,
      contextMode: "changes",
      detailMode: "diff",
      gitStatus: null,
      gitStatusError: null,
      gitStatusLoading: false,
      gitStatusRefreshing: false,
      selectedGitPathId: "path-1",
      selectedGitSide: "unstaged",
      gitDiff: { status: "loading", pathId: "path-1", side: "unstaged" },
    };
    const harness = createHarness(selected);

    harness.controller.prepareResourceOpen("changes");
    expect(harness.state().selectedGitPathId).toBe("path-1");

    harness.controller.prepareResourceOpen("files");
    expect(harness.state()).toMatchObject({
      selectedGitPathId: null,
      selectedGitSide: null,
      gitDiff: null,
    });
  });
});
