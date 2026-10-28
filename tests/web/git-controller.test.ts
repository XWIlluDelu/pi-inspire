// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffSide,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import type { Api } from "../../src/api";
import {
  GitController,
  type GitControllerPatch,
  type GitControllerState,
} from "../../src/controllers/git-controller";

const notRepository: GitStatusResponse = { kind: "not-repository" };
const path = { id: "file", display: "file.txt", utf8Path: "file.txt" };
const modified: GitStatusResponse = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "abc" },
  files: [
    {
      path,
      unstaged: { kind: "modified" },
      worktree: { kind: "modified" as const },
      untracked: false,
    },
  ],
  total: 1,
  truncated: false,
  groups: { conflicted: [], staged: [], unstaged: [path.id], untracked: [] },
};
const diff = (version: string) => ({
  kind: "text" as const,
  path,
  side: "worktree" as const,
  additions: 1,
  deletions: 0,
  truncated: false,
  encodingLossy: false,
  lines: [
    { kind: "add" as const, text: `+${version}`, oldLine: null, newLine: 1 },
  ],
});
const visibleSelection = {
  resourcesOpen: true,
  contextMode: "files" as const,
  fileChangesVisible: true,
  gitStatus: modified,
  selectedGitPathId: path.id,
  selectedGitSide: "worktree" as const,
  gitDiff: { status: "ready" as const, result: diff("before") },
};

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
  const openResourceFromGit =
    vi.fn<(change: GitFileChange, side: GitDiffSide) => Promise<void>>();
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

  it.each([undefined, "staged", "unstaged"] as const)(
    "opens the net comparison even when a legacy caller requests %s",
    async (legacySide) => {
      const harness = createHarness({ gitStatus: modified });
      harness.gitDiff.mockResolvedValue(diff("net"));

      await harness.controller.openChange(path.id, legacySide);

      expect(harness.gitDiff).toHaveBeenCalledExactlyOnceWith(
        "s1",
        path.id,
        "worktree",
        expect.any(AbortSignal),
      );
      expect(harness.state().selectedGitSide).toBe("worktree");
    },
  );

  it("does not use native index facets as evidence of a net change", async () => {
    const harness = createHarness({
      gitStatus: {
        ...modified,
        files: [
          {
            path,
            staged: { kind: "modified" },
            unstaged: { kind: "modified" },
            untracked: false,
          },
        ],
      },
    });

    await harness.controller.openChange(path.id);
    harness.controller.selectWorkspacePath("file.txt");

    expect(harness.gitDiff).not.toHaveBeenCalled();
    expect(harness.openResourceFromGit).not.toHaveBeenCalled();
    expect(harness.state().selectedGitPathId).toBeNull();
  });

  it.each([
    { path, worktree: { kind: "added" }, untracked: true },
    { path, conflict: { code: "UU" }, untracked: false },
  ] satisfies GitFileChange[])(
    "opens a net addition or conflict without requiring index facets: %j",
    async (change) => {
      const harness = createHarness({
        gitStatus: { ...modified, files: [change] },
      });
      harness.gitDiff.mockResolvedValue(diff("net"));

      await harness.controller.openChange(path.id);

      expect(harness.openResourceFromGit).toHaveBeenCalledExactlyOnceWith(
        change,
        "worktree",
      );
      expect(harness.gitDiff).toHaveBeenCalledExactlyOnceWith(
        "s1",
        path.id,
        "worktree",
        expect.any(AbortSignal),
      );
    },
  );

  it("cancels a pending comparison when fresh net status removes the path", async () => {
    const harness = createHarness({ gitStatus: modified });
    let finish!: (value: ReturnType<typeof diff>) => void;
    harness.gitDiff.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = harness.controller.openChange(path.id);
    await vi.waitFor(() => expect(harness.gitDiff).toHaveBeenCalledTimes(1));
    const signal = harness.gitDiff.mock.calls[0]![3] as AbortSignal;
    harness.gitStatus.mockResolvedValue({
      ...modified,
      files: [],
      total: 0,
      groups: { conflicted: [], staged: [], unstaged: [], untracked: [] },
    });

    await harness.controller.refreshStatus();
    expect(signal.aborted).toBe(true);
    expect(harness.state()).toMatchObject({
      selectedGitPathId: null,
      selectedGitSide: null,
      gitDiff: null,
    });
    finish(diff("late native change"));
    await opening;
    expect(harness.state().gitDiff).toBeNull();
  });

  it("retains readable source while coalescing refresh hints behind a slow diff", async () => {
    const harness = createHarness(visibleSelection);
    const releases: Array<(value: ReturnType<typeof diff>) => void> = [];
    harness.gitStatus.mockResolvedValue(modified);
    harness.gitDiff.mockImplementation(
      () => new Promise((resolve) => releases.push(resolve)),
    );
    try {
      harness.controller.setSurfaceVisible("detail", true);
      await vi.waitFor(() => expect(harness.gitDiff).toHaveBeenCalledTimes(1));
      const refreshes = [
        harness.controller.refreshStatus(),
        harness.controller.refreshStatus(),
        harness.controller.refreshStatus(),
        harness.controller.openDiff(path.id, "worktree"),
      ];
      expect(harness.gitDiff).toHaveBeenCalledTimes(1);
      expect(harness.state().gitDiff).toMatchObject({
        status: "ready",
        result: diff("before"),
      });

      releases.shift()!(diff("first update"));
      await vi.waitFor(() => expect(harness.gitDiff).toHaveBeenCalledTimes(2));
      expect(harness.state().gitDiff).toMatchObject({
        status: "ready",
        result: diff("first update"),
      });
      releases.shift()!(diff("latest update"));
      await Promise.all(refreshes);
      expect(harness.gitStatus).toHaveBeenCalledTimes(2);
      expect(harness.gitDiff).toHaveBeenCalledTimes(2);
      expect(harness.state().gitDiff).toMatchObject({
        status: "ready",
        result: diff("latest update"),
      });
    } finally {
      harness.controller.setSurfaceVisible("detail", false);
      harness.controller.cancelAll();
    }
  });

  it("keeps the last source visibly stale on failure and clears the warning on recovery", async () => {
    const harness = createHarness(visibleSelection);
    harness.gitStatus.mockResolvedValue(modified);
    harness.gitDiff.mockRejectedValueOnce(new Error("Repository busy"));
    await harness.controller.refreshStatus();
    expect(harness.state().gitDiff).toMatchObject({
      status: "ready",
      result: diff("before"),
      refreshError: "Repository busy",
    });

    harness.gitDiff.mockResolvedValue(diff("recovered"));
    await harness.controller.refreshStatus();
    expect(harness.state().gitDiff).toEqual({
      status: "ready",
      result: diff("recovered"),
    });
  });

  it("cannot replace a newer file selection with an old background refresh", async () => {
    const other = { id: "other", display: "other.txt", utf8Path: "other.txt" };
    const status = {
      ...modified,
      files: [
        ...modified.files,
        {
          path: other,
          unstaged: { kind: "modified" as const },
          worktree: { kind: "modified" as const },
          untracked: false,
        },
      ],
    };
    const harness = createHarness({ ...visibleSelection, gitStatus: status });
    harness.gitStatus.mockResolvedValue(status);
    let release!: (value: ReturnType<typeof diff>) => void;
    harness.gitDiff
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...diff("new selection"), path: other });
    const refresh = harness.controller.refreshStatus();
    await vi.waitFor(() => expect(harness.gitDiff).toHaveBeenCalledTimes(1));
    await harness.controller.openChange(other.id);
    release(diff("late old file"));
    await refresh;
    expect(harness.state()).toMatchObject({
      selectedGitPathId: other.id,
      gitDiff: {
        status: "ready",
        result: { path: other, lines: [{ text: "+new selection" }] },
      },
    });
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
          worktree: { kind: "modified" as const },
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
      selectedGitSide: "worktree",
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
          worktree: { kind: "modified" as const },
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
      side: "worktree" as const,
      reason: "no-changes" as const,
    };
    harness.gitDiff.mockResolvedValue(diff);

    await harness.controller.openChange(path.id);

    expect(harness.gitStatus).toHaveBeenCalledTimes(1);
    expect(harness.openResourceFromGit).toHaveBeenCalledWith(
      {
        path,
        unstaged: { kind: "modified" },
        worktree: { kind: "modified" as const },
        untracked: false,
      },
      "worktree",
    );
    expect(harness.gitDiff).toHaveBeenCalledTimes(1);
    expect(harness.state().gitDiff).toEqual({ status: "ready", result: diff });
    expect(harness.state().contextMode).toBe("files");
  });

  it.each([
    {
      label: "deleted working file",
      change: {
        path: { ...path, workspacePath: "file.txt" },
        unstaged: { kind: "deleted" },
        worktree: { kind: "deleted" },
        untracked: false,
      } satisfies GitFileChange,
      side: "worktree" as const,
    },
    {
      label: "deleted staged file",
      change: {
        path: { ...path, workspacePath: "file.txt" },
        staged: { kind: "deleted" },
        worktree: { kind: "deleted" },
        untracked: false,
      } satisfies GitFileChange,
      side: "worktree" as const,
    },
    {
      label: "non-UTF-8 Git identity",
      change: {
        path: { id: "raw-path", display: "escaped pathname" },
        unstaged: { kind: "modified" },
        worktree: { kind: "modified" as const },
        untracked: false,
      } satisfies GitFileChange,
      side: "worktree" as const,
    },
    {
      label: "path outside the workspace",
      change: modified.files[0],
      side: "worktree" as const,
    },
  ])(
    "opens a file tab for $label without waiting for its body",
    async ({ change, side }) => {
      const harness = createHarness({
        gitStatus: { ...modified, files: [change] },
      });
      harness.openResourceFromGit.mockReturnValue(new Promise(() => {}));
      const result = { ...diff("selected"), path: change.path, side };
      harness.gitDiff.mockResolvedValue(result);

      await harness.controller.openChange(change.path.id, side);

      expect(harness.openResourceFromGit).toHaveBeenCalledExactlyOnceWith(
        change,
        side,
      );
      expect(harness.gitDiff).toHaveBeenCalledWith(
        "s1",
        change.path.id,
        side,
        expect.any(AbortSignal),
      );
      expect(harness.state()).toMatchObject({
        resourcesOpen: true,
        contextMode: "files",
        selectedGitPathId: change.path.id,
        selectedGitSide: side,
        gitDiff: { status: "ready", result },
      });
    },
  );

  it("refreshes a selected comparison only in a visible file Changes view", async () => {
    const harness = createHarness({
      ...visibleSelection,
      contextMode: "changes",
      fileChangesVisible: false,
    });
    harness.gitStatus.mockResolvedValue(modified);
    harness.gitDiff.mockResolvedValue(diff("latest"));

    await harness.controller.refreshStatus();
    expect(harness.gitStatus).toHaveBeenCalledTimes(1);
    expect(harness.gitDiff).not.toHaveBeenCalled();

    harness.patch({ contextMode: "files", fileChangesVisible: true });
    await harness.controller.refreshStatus();
    expect(harness.gitDiff).toHaveBeenCalledTimes(1);
    expect(harness.state().gitDiff).toEqual({
      status: "ready",
      result: diff("latest"),
    });

    harness.patch({ fileChangesVisible: false });
    await harness.controller.refreshStatus();
    harness.patch({ resourcesOpen: false, fileChangesVisible: true });
    await harness.controller.refreshStatus();
    expect(harness.gitDiff).toHaveBeenCalledTimes(1);
  });

  it("preserves the net comparison when the resource resolves", () => {
    const path = {
      id: "dual-path",
      display: "src/dual.ts",
      utf8Path: "src/dual.ts",
      workspacePath: "src/dual.ts",
    };
    const gitDiff = {
      status: "loading" as const,
      pathId: path.id,
      side: "worktree" as const,
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
            worktree: { kind: "modified" as const },
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
      selectedGitSide: "worktree",
      gitDiff,
    });

    harness.controller.selectWorkspacePath(path.workspacePath);

    expect(harness.state()).toMatchObject({
      selectedGitPathId: path.id,
      selectedGitSide: "worktree",
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
            worktree: { kind: "modified" as const },
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
      selectedGitSide: "worktree",
      gitDiff: {
        status: "loading",
        pathId: changedPath.id,
        side: "worktree",
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
      selectedGitSide: "worktree",
      gitDiff: { status: "loading", pathId: "path-1", side: "worktree" },
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
