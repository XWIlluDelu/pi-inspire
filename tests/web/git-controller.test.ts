// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitStatusResponse } from "../../shared/contracts";
import type { Api } from "../../src/api";
import {
  GitController,
  type GitControllerPatch,
  type GitControllerState,
  inspectedGitChange,
} from "../../src/controllers/git-controller";
import { deferred } from "./helpers";

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
};
const diff = (version: string) => ({
  kind: "text" as const,
  path,
  additions: 1,
  deletions: 0,
  truncated: false,
  encodingLossy: false,
  lines: [
    { kind: "add" as const, text: `+${version}`, oldLine: null, newLine: 1 },
  ],
});
function fileSelection(path: GitFileChange["path"]) {
  const reference = path.workspacePath ?? `pi-git://${path.id}`;
  return {
    resourcesOpen: true,
    contextMode: "files" as const,
    fileInspection: {
      kind: "file" as const,
      reference,
      workspacePath: path.workspacePath,
      preview: null,
    },
    resourceTabs: [
      {
        reference,
        workspacePath: path.workspacePath,
        view: "changes" as const,
        git: { pathId: path.id, displayPath: path.display },
      },
    ],
  };
}

const visibleSelection = {
  ...fileSelection(path),
  gitStatus: modified,
  gitDiff: { status: "ready" as const, result: diff("before") },
};

function createHarness(initial: Partial<GitControllerState> = {}) {
  let state: GitControllerState = {
    sessionId: "s1",
    selectionGeneration: 1,
    resourcesOpen: false,
    contextMode: "files",
    fileInspection: { kind: "browse" },
    resourceTabs: [],
    gitStatus: null,
    gitStatusError: null,
    gitStatusLoading: false,
    gitStatusRefreshing: false,
    gitDiff: null,
    ...initial,
  };
  const gitStatus = vi.fn();
  const gitDiff = vi.fn();
  const api = { gitStatus, gitDiff } as unknown as Api;
  const openResourceFromGit = vi.fn<(change: GitFileChange) => Promise<void>>(
    () => Promise.resolve(),
  );
  const controller = new GitController({
    state: () => state,
    patch: (patch: GitControllerPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    handleAuthFailure: vi.fn(),
    openResourceFromGit: (change) => {
      state = { ...state, ...fileSelection(change.path) };
      return openResourceFromGit(change);
    },
  });
  return {
    controller,
    state: () => state,
    patch: (patch: Partial<GitControllerState>) => {
      state = { ...state, ...patch };
    },
    gitStatus,
    gitDiff,
    openResourceFromGit,
  };
}

function pollVisibleComparison(status = modified) {
  vi.useFakeTimers();
  const harness = createHarness({ ...visibleSelection, gitStatus: status });
  harness.gitStatus.mockResolvedValue(status);
  harness.gitDiff.mockImplementation(async () => diff("before"));
  harness.controller.setSurfaceVisible("detail", true);
  return harness;
}

describe("GitController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens reported net changes without waiting for the file body", async () => {
    const eligible = [
      {
        path: { id: "added", display: "added.txt", utf8Path: "added.txt" },
        worktree: { kind: "added" },
        untracked: true,
      },
      {
        path: {
          id: "conflict",
          display: "conflict.txt",
          utf8Path: "conflict.txt",
        },
        conflict: { code: "UU" },
        untracked: false,
      },
    ] satisfies GitFileChange[];
    const harness = createHarness();
    harness.gitStatus.mockResolvedValue({
      ...modified,
      files: [
        {
          path,
          staged: { kind: "modified" },
          unstaged: { kind: "modified" },
          untracked: false,
        },
        ...eligible,
      ],
      total: eligible.length,
    });
    harness.openResourceFromGit.mockReturnValue(new Promise(() => {}));

    await harness.controller.openChange(path.id);
    expect(harness.gitDiff).not.toHaveBeenCalled();
    expect(harness.openResourceFromGit).not.toHaveBeenCalled();

    for (const change of eligible) {
      const result = { ...diff("selected"), path: change.path };
      harness.gitDiff.mockResolvedValueOnce(result);
      await harness.controller.openChange(change.path.id);
      expect(harness.state().gitDiff).toMatchObject({
        status: "ready",
        result,
      });
    }
    expect(harness.gitStatus).toHaveBeenCalledOnce();
    expect(harness.openResourceFromGit.mock.calls).toEqual(
      eligible.map((change) => [change]),
    );
    expect(
      harness.gitDiff.mock.calls.map(([session, id]) => [session, id]),
    ).toEqual(eligible.map(({ path }) => ["s1", path.id]));
  });

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
    const signal = harness.gitDiff.mock.calls[0]![2] as AbortSignal;
    harness.gitStatus.mockResolvedValue({
      ...modified,
      files: [],
      total: 0,
    });

    await harness.controller.refreshStatus();
    expect(signal.aborted).toBe(true);
    const state = harness.state();
    expect(inspectedGitChange(state, state.gitStatus)).toBeUndefined();
    expect(state.gitDiff).toBeNull();
    finish(diff("late native change"));
    await opening;
    expect(harness.state().gitDiff).toBeNull();
  });

  it("coalesces refreshes and retires a pending status when the selection changes", async () => {
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
        harness.controller.openChange(path.id),
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

      const late = deferred<GitStatusResponse>();
      harness.gitStatus.mockReturnValueOnce(late.promise);
      const pending = harness.controller.refreshStatus();
      harness.patch({
        selectionGeneration: 2,
        sessionId: "s2",
        gitStatus: null,
      });
      late.resolve(notRepository);
      await pending;
      expect(harness.state().gitStatus).toBeNull();
    } finally {
      harness.controller.setSurfaceVisible("detail", false);
    }
  });

  it("backs off after two unchanged reads but detects new diff content with the same status", async () => {
    const harness = pollVisibleComparison();
    await vi.advanceTimersByTimeAsync(0);

    for (const count of [2, 3]) {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.gitDiff).toHaveBeenCalledTimes(count);
    }
    await vi.advanceTimersByTimeAsync(7_999);
    expect(harness.gitDiff).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.gitDiff).toHaveBeenCalledTimes(4);

    harness.gitDiff.mockResolvedValue(diff("edited while still modified"));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.state().gitDiff).toMatchObject({
      result: diff("edited while still modified"),
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(harness.gitDiff).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.gitDiff).toHaveBeenCalledTimes(6);
    harness.controller.setSurfaceVisible("detail", false);
  });

  it.each(["status", "diff"] as const)(
    "restores the fast interval after a %s read fails",
    async (failedRead) => {
      const harness = pollVisibleComparison();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(3);

      (failedRead === "status"
        ? harness.gitStatus
        : harness.gitDiff
      ).mockRejectedValueOnce(new Error("Read failed"));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(4);
      const failed = harness.state();
      expect(
        failedRead === "status"
          ? failed.gitStatusError
          : failed.gitDiff?.status === "ready" && failed.gitDiff.refreshError,
      ).toBe("Read failed");
      expect(failed.gitStatus).toEqual(modified);
      expect(failed.gitDiff).toMatchObject({
        status: "ready",
        result: diff("before"),
      });

      harness.gitDiff.mockResolvedValue(diff("recovered"));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(5);
      expect(harness.state()).toMatchObject({
        gitStatusError: null,
        gitDiff: { status: "ready", result: diff("recovered") },
      });
      expect(harness.state().gitDiff).not.toHaveProperty("refreshError");
      harness.controller.setSurfaceVisible("detail", false);
    },
  );

  it.each(["manual", "visible"] as const)(
    "refreshes immediately and resets stable polling on %s intent",
    async (intent) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(
        () => visibility,
      );
      const harness = pollVisibleComparison();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(3);
      if (intent === "manual") await harness.controller.refreshStatus();
      else {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(harness.gitStatus).toHaveBeenCalledTimes(3);
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(harness.gitStatus).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.gitStatus).toHaveBeenCalledTimes(6);
      harness.controller.setSurfaceVisible("detail", false);
    },
  );

  it("uses summary cadence without reading hidden diff and refreshes when detail returns", async () => {
    const harness = pollVisibleComparison();
    harness.controller.setSurfaceVisible("topbar-git", true);
    await vi.advanceTimersByTimeAsync(8_000);
    const before = harness.gitStatus.mock.calls.length;
    const diffBefore = harness.gitDiff.mock.calls.length;

    harness.patch({ contextMode: "changes" });
    harness.controller.setSurfaceVisible("detail", false);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(harness.gitStatus).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.gitStatus).toHaveBeenCalledTimes(before + 1);
    expect(harness.gitDiff).toHaveBeenCalledTimes(diffBefore);

    harness.patch({ contextMode: "files" });
    harness.controller.setSurfaceVisible("detail", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.gitStatus).toHaveBeenCalledTimes(before + 2);
    expect(harness.gitDiff).toHaveBeenCalledTimes(diffBefore + 1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(before + 3);
    harness.controller.setSurfaceVisible("detail", false);
    harness.controller.setSurfaceVisible("topbar-git", false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(before + 3);
  });

  it("waits for a slow diff and keeps a new selection's cadence independent of the old read", async () => {
    const other = { id: "other", display: "other.txt", utf8Path: "other.txt" };
    const status = {
      ...modified,
      files: [
        ...modified.files,
        {
          path: other,
          worktree: { kind: "modified" as const },
          untracked: false,
        },
      ],
    };
    const harness = pollVisibleComparison(status);
    await vi.advanceTimersByTimeAsync(8_000);
    const late = deferred<ReturnType<typeof diff>>();
    harness.gitDiff.mockReturnValueOnce(late.promise);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(4);
    expect(harness.gitDiff).toHaveBeenCalledTimes(4);

    const nextDiff = { ...diff("new selection"), path: other };
    harness.gitDiff.mockResolvedValue(nextDiff);
    await harness.controller.openChange(other.id);
    late.resolve(diff("before"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state().gitDiff).toMatchObject({ result: nextDiff });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.gitStatus).toHaveBeenCalledTimes(6);
    harness.controller.setSurfaceVisible("detail", false);
  });
});
