import { afterEach, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import type { Api } from "../../src/api";
import {
  GitController,
  type GitControllerState,
  inspectedGitChange,
} from "../../src/controllers/git-controller";
import { deferred } from "./helpers";

const path = { id: "file", display: "file.txt", utf8Path: "file.txt" };
const other = { id: "other", display: "other.txt", utf8Path: "other.txt" };
const changed = (path: GitFileChange["path"]): GitFileChange => ({
  path,
  worktree: { kind: "modified" },
  untracked: false,
});
const status = (files = [changed(path)]): GitStatusResponse => ({
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "abc" },
  files,
  total: files.length,
  truncated: false,
});
const diff = (text: string, selected = path): GitDiffResponse => ({
  kind: "text",
  path: selected,
  additions: 1,
  deletions: 0,
  truncated: false,
  encodingLossy: false,
  lines: [{ kind: "add", text, oldLine: null, newLine: 1 }],
});
const before = diff("before");

function fixture(files = [changed(path)], visible = true) {
  function selected(path: GitFileChange["path"]) {
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
  let state: GitControllerState = {
    sessionId: "s1",
    selectionGeneration: 1,
    resourcesOpen: false,
    contextMode: "files",
    fileInspection: { kind: "browse" },
    resourceTabs: [],
    gitStatus: null,
    gitStatusPending: false,
    gitStatusError: null,
    gitDiff: null,
    ...(visible
      ? {
          ...selected(path),
          gitStatus: status(files),
          gitDiff: { status: "ready" as const, result: before },
        }
      : {}),
  };
  const gitStatus = vi.fn<Api["gitStatus"]>().mockResolvedValue(status(files));
  const gitDiff = vi.fn<Api["gitDiff"]>().mockResolvedValue(before);
  const api = { gitStatus, gitDiff } as unknown as Api;
  const patch = (next: Partial<GitControllerState>) => {
    state = { ...state, ...next };
  };
  const openResource = vi.fn((change: GitFileChange) => {
    patch(selected(change.path));
    return Promise.resolve();
  });
  const controller = new GitController({
    state: () => state,
    patch,
    api: () => api,
    handleAuthFailure: vi.fn(),
    openResourceFromGit: openResource,
  });
  return {
    controller,
    get state() {
      return state;
    },
    patch,
    gitStatus,
    gitDiff,
    openResource,
  };
}

const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
afterEach(() => vi.useRealTimers());

it("starts net Changes without waiting for the file and cancels an obsolete comparison", async () => {
  const squashed: GitFileChange = {
    path,
    staged: { kind: "modified" },
    unstaged: { kind: "modified" },
    untracked: false,
  };
  const added: GitFileChange = {
    path: other,
    worktree: { kind: "added" },
    untracked: true,
  };
  const conflict: GitFileChange = {
    path: { id: "conflict", display: "conflict.txt" },
    conflict: { code: "UU" },
    untracked: false,
  };
  const f = fixture([squashed, added, conflict], false);
  await f.controller.openChange(squashed.path.id);
  expect(f.openResource).not.toHaveBeenCalled();
  expect(f.gitDiff).not.toHaveBeenCalled();
  const fileRead = deferred<void>();
  const answer = f.openResource.getMockImplementation()!;
  f.openResource.mockImplementation((change) => {
    void answer(change);
    return fileRead.promise;
  });
  const first = {
    ...diff("added"),
    path: added.path,
  } satisfies GitDiffResponse;
  f.gitDiff.mockResolvedValueOnce(first);
  await f.controller.openChange(added.path.id);
  expect(f.state.gitDiff).toMatchObject({ status: "ready", result: first });

  const stale = deferred<GitDiffResponse>();
  f.gitDiff.mockReturnValueOnce(stale.promise);
  const starting = f.controller.openChange(conflict.path.id);
  await vi.waitFor(() => expect(f.gitDiff).toHaveBeenCalledTimes(2));
  const [, id, signal] = f.gitDiff.mock.calls[1]!;
  expect(id).toBe("conflict");
  f.gitStatus.mockResolvedValueOnce(status([]));
  await f.controller.refreshStatus();
  expect(signal?.aborted).toBe(true);
  expect(inspectedGitChange(f.state, f.state.gitStatus)).toBeUndefined();
  stale.resolve({ ...diff("late"), path: conflict.path });
  fileRead.resolve();
  await starting;
  expect(f.state.gitDiff).toBeNull();
});

it("coalesces repeated status hints and ignores an old session's result", async () => {
  const f = fixture();
  const first = deferred<GitDiffResponse>();
  const latest = deferred<GitDiffResponse>();
  f.gitDiff
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  const original = f.controller.refreshStatus();
  await vi.waitFor(() => expect(f.gitDiff).toHaveBeenCalledOnce());
  const hints = [
    f.controller.refreshStatus(),
    f.controller.refreshStatus(),
    f.controller.openChange(path.id),
  ];
  expect(f.state.gitDiff).toMatchObject({ status: "ready", result: before });
  first.resolve(diff("first update"));
  await vi.waitFor(() => expect(f.gitDiff).toHaveBeenCalledTimes(2));
  expect(f.state.gitDiff).toMatchObject({ result: diff("first update") });
  latest.resolve(diff("latest update"));
  await Promise.all([original, ...hints]);
  expect(f.gitStatus).toHaveBeenCalledTimes(2);
  expect(f.state.gitDiff).toMatchObject({ result: diff("latest update") });

  const stale = deferred<GitStatusResponse>();
  f.gitStatus.mockReturnValueOnce(stale.promise);
  const reading = f.controller.refreshStatus();
  await vi.waitFor(() => expect(f.gitStatus).toHaveBeenCalledTimes(3));
  f.patch({
    sessionId: "s2",
    selectionGeneration: 2,
    gitStatus: null,
  });
  stale.resolve({ kind: "not-repository" });
  await reading;
  expect(f.state.gitStatus).toBeNull();
});

it.each([
  "changed diff",
  "status error",
  "diff error",
  "manual",
  "page visibility",
] as const)(
  "returns to fast polling after %s breaks a stable comparison",
  async (intent) => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const f = fixture();
    f.controller.setSurfaceVisible("detail", true);
    try {
      await advance(8_000);
      expect(f.gitStatus).toHaveBeenCalledTimes(3);
      await advance(7_999);
      expect(f.gitStatus).toHaveBeenCalledTimes(3);
      const updated = diff("edited while status remains modified");
      if (intent === "changed diff") f.gitDiff.mockResolvedValueOnce(updated);
      if (intent === "status error")
        f.gitStatus.mockRejectedValueOnce(new Error("Status failed"));
      if (intent === "diff error")
        f.gitDiff.mockRejectedValueOnce(new Error("Diff failed"));
      if (intent === "manual") await f.controller.refreshStatus();
      else if (intent === "page visibility") {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        await advance(30_000);
        expect(f.gitStatus).toHaveBeenCalledTimes(3);
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        await advance();
      } else await advance(1);
      expect(f.gitStatus).toHaveBeenCalledTimes(4);
      if (intent === "status error")
        expect(f.state.gitStatusError).toBe("Status failed");
      expect(f.state.gitStatus).toEqual(status());
      expect(f.state.gitDiff).toMatchObject({
        status: "ready",
        result: intent === "changed diff" ? updated : before,
        ...(intent === "diff error" ? { refreshError: "Diff failed" } : {}),
      });
      f.gitDiff.mockResolvedValue(updated);
      await advance(3_999);
      expect(f.gitStatus).toHaveBeenCalledTimes(4);
      await advance(1);
      expect(f.gitStatus).toHaveBeenCalledTimes(5);
      expect(f.state.gitStatusError).toBeNull();
      expect(f.state.gitDiff).toMatchObject({
        status: "ready",
        result: updated,
      });
      expect(f.state.gitDiff).not.toHaveProperty("refreshError");
    } finally {
      f.controller.setSurfaceVisible("detail", false);
    }
  },
);

it("reads only summary while hidden and never lets a slow comparison schedule or replace a new one", async () => {
  vi.useFakeTimers();
  const f = fixture([changed(path), changed(other)]);
  f.controller.setSurfaceVisible("detail", true);
  f.controller.setSurfaceVisible("topbar-git", true);
  try {
    await advance();
    expect(f.gitDiff).toHaveBeenCalledOnce();
    f.patch({ contextMode: "changes" });
    f.controller.setSurfaceVisible("detail", false);
    await advance(19_999);
    expect(f.gitStatus).toHaveBeenCalledOnce();
    await advance(1);
    expect(f.gitStatus).toHaveBeenCalledTimes(2);
    expect(f.gitDiff).toHaveBeenCalledOnce();

    f.patch({ contextMode: "files" });
    f.controller.setSurfaceVisible("detail", true);
    await advance();
    expect(f.gitDiff).toHaveBeenCalledTimes(2);
    const late = deferred<GitDiffResponse>();
    f.gitDiff.mockReturnValueOnce(late.promise);
    await advance(4_000);
    expect(f.gitStatus).toHaveBeenCalledTimes(4);
    await advance(30_000);
    expect(f.gitStatus).toHaveBeenCalledTimes(4);
    const next = diff("new selection", other);
    f.gitDiff.mockResolvedValue(next);
    await f.controller.openChange(other.id);
    late.resolve(before);
    await advance();
    expect(f.state.gitDiff).toMatchObject({ result: next });
    await advance(4_000);
    expect(f.gitStatus).toHaveBeenCalledTimes(5);
    await advance(4_000);
    expect(f.gitStatus).toHaveBeenCalledTimes(6);
  } finally {
    f.controller.setSurfaceVisible("detail", false);
    f.controller.setSurfaceVisible("topbar-git", false);
  }
  await advance(20_000);
  expect(f.gitStatus).toHaveBeenCalledTimes(6);
});
