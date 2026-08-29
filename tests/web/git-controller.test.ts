// @vitest-environment jsdom
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
  const openResourceFromGit = vi.fn<(path: string) => Promise<void>>();
  const handleAuthFailure = vi.fn();
  const controller = new GitController({
    state: () => state,
    patch: (patch: GitControllerPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => 1,
    handleAuthFailure,
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
    handleAuthFailure,
    openResourceFromGit,
  };
}

describe("GitController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

  it("uses a lower polling cadence when only the topbar summary is visible", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.gitStatus.mockResolvedValue(notRepository);

    harness.controller.setSurfaceVisible("topbar-git", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.gitStatus).toHaveBeenCalledTimes(2);

    harness.controller.setSurfaceVisible("topbar-git", false);
  });

  it("pauses polling while the page is hidden and refreshes on return", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const harness = createHarness();
    harness.gitStatus.mockResolvedValue(notRepository);

    harness.controller.setSurfaceVisible("test", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.gitStatus).toHaveBeenCalledTimes(2);
    harness.controller.setSurfaceVisible("test", false);
  });

  it("adopts a workspace selection when a later Git status identifies it", async () => {
    const harness = createHarness();
    harness.controller.selectWorkspacePath("src/main.ts");
    harness.gitStatus.mockResolvedValue({
      kind: "repository",
      head: { kind: "branch", name: "main", oid: "abc" },
      files: [
        {
          path: {
            id: "main-path",
            display: "src/main.ts",
            utf8Path: "src/main.ts",
            workspacePath: "src/main.ts",
          },
          unstaged: { kind: "modified" },
          untracked: false,
        },
      ],
      total: 1,
      truncated: false,
      groups: {
        conflicted: [],
        staged: [],
        unstaged: ["main-path"],
        untracked: [],
      },
    });

    await harness.controller.refreshStatus();

    expect(harness.state()).toMatchObject({
      selectedGitPathId: "main-path",
      selectedGitSide: "unstaged",
    });
  });

  it("resolves a change once before opening its resource and diff", async () => {
    const path = {
      id: "main-path",
      display: "src/main.ts",
      utf8Path: "src/main.ts",
      workspacePath: "src/main.ts",
    };
    const harness = createHarness();
    harness.gitStatus.mockResolvedValue({
      kind: "repository",
      head: { kind: "branch", name: "main", oid: "abc" },
      files: [
        {
          path,
          unstaged: { kind: "modified" },
          untracked: false,
        },
      ],
      total: 1,
      truncated: false,
      groups: {
        conflicted: [],
        staged: [],
        unstaged: [path.id],
        untracked: [],
      },
    });
    const diff = {
      kind: "empty" as const,
      path,
      side: "unstaged" as const,
      reason: "no-changes" as const,
    };
    harness.gitDiff.mockResolvedValue(diff);

    await harness.controller.openChange(path.id);

    expect(harness.gitStatus).toHaveBeenCalledTimes(1);
    expect(harness.openResourceFromGit).toHaveBeenCalledWith(
      path.workspacePath,
    );
    expect(harness.gitDiff).toHaveBeenCalledTimes(1);
    expect(harness.state().gitDiff).toEqual({ status: "ready", result: diff });
  });

  it("preserves an explicit staged selection when the resource resolves", () => {
    const path = {
      id: "dual-path",
      display: "src/dual.ts",
      utf8Path: "src/dual.ts",
      workspacePath: "src/dual.ts",
    };
    const gitDiff = {
      status: "loading" as const,
      pathId: path.id,
      side: "staged" as const,
    };
    const harness = createHarness({
      gitStatus: {
        kind: "repository",
        head: { kind: "branch", name: "main", oid: "abc" },
        files: [
          {
            path,
            staged: { kind: "modified" },
            unstaged: { kind: "modified" },
            untracked: false,
          },
        ],
        total: 1,
        truncated: false,
        groups: {
          conflicted: [],
          staged: [path.id],
          unstaged: [path.id],
          untracked: [],
        },
      },
      selectedGitPathId: path.id,
      selectedGitSide: "staged",
      gitDiff,
    });

    harness.controller.selectWorkspacePath(path.workspacePath);

    expect(harness.state()).toMatchObject({
      selectedGitPathId: path.id,
      selectedGitSide: "staged",
      gitDiff,
    });
  });

  it("keeps an unmodified workspace file while clearing a previous diff", () => {
    const changedPath = {
      id: "changed-path",
      display: "src/changed.ts",
      utf8Path: "src/changed.ts",
      workspacePath: "src/changed.ts",
    };
    const harness = createHarness({
      gitStatus: {
        kind: "repository",
        head: { kind: "branch", name: "main", oid: "abc" },
        files: [
          {
            path: changedPath,
            unstaged: { kind: "modified" },
            untracked: false,
          },
        ],
        total: 1,
        truncated: false,
        groups: {
          conflicted: [],
          staged: [],
          unstaged: [changedPath.id],
          untracked: [],
        },
      },
      selectedGitPathId: changedPath.id,
      selectedGitSide: "unstaged",
      gitDiff: {
        status: "loading",
        pathId: changedPath.id,
        side: "unstaged",
      },
    });

    harness.controller.selectWorkspacePath("src/clean.ts");

    expect(harness.state()).toMatchObject({
      selectedGitPathId: null,
      selectedGitSide: null,
      gitDiff: null,
    });
  });

  it("clears Git selection only when a Files resource replaces it", () => {
    const selected: GitControllerState = {
      sessionId: "s1",
      selectionGeneration: 1,
      resourcesOpen: true,
      contextMode: "changes",
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
