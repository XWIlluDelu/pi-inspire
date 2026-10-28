import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitStatusResponse } from "../../shared/contracts";
import {
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

const change: GitFileChange = {
  path: {
    id: "src-readme",
    display: "src/readme.md",
    utf8Path: "src/readme.md",
    workspacePath: "src/readme.md",
  },
  staged: { kind: "modified" },
  unstaged: { kind: "modified" },
  worktree: { kind: "modified" as const },
  untracked: false,
};

function repository(files: GitFileChange[]): GitStatusResponse {
  return {
    kind: "repository",
    head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
    files,
    total: files.length,
    truncated: false,
    groups: {
      conflicted: [],
      staged: files.filter((file) => file.staged).map((file) => file.path.id),
      unstaged: files
        .filter((file) => file.unstaged)
        .map((file) => file.path.id),
      untracked: files
        .filter((file) => file.untracked)
        .map((file) => file.path.id),
    },
  };
}

describe("ordinary file tabs with Git views", () => {
  let status: GitStatusResponse;
  let statusFailure: boolean;
  let statusWait: Promise<void> | null;
  let resolved: string[];
  let diffs: Array<{ pathId: string; side: string }>;

  beforeEach(() => {
    installFakeWebSocket();
    status = repository([change]);
    statusFailure = false;
    statusWait = null;
    resolved = [];
    diffs = [];
    installFetch(async (url, init) => {
      if (url.startsWith("/api/git/status")) {
        if (statusWait) await statusWait;
        return statusFailure
          ? { status: 503, body: { error: "Git unavailable" } }
          : { body: status };
      }
      if (url.startsWith("/api/git/diff")) {
        const { pathId, side } = jsonBody(init);
        diffs.push({ pathId: String(pathId), side: String(side) });
        const file =
          status.kind === "repository"
            ? status.files.find((file) => file.path.id === pathId)
            : undefined;
        return { body: { kind: "binary", path: file?.path, side } };
      }
      if (url.startsWith("/api/resources/resolve")) {
        const { reference, workspacePath, sessionId } = jsonBody(init);
        resolved.push(String(reference));
        if (reference === "deleted.txt")
          return { status: 404, body: { error: "File was deleted" } };
        return {
          body: {
            id: `fresh-${resolved.length}`,
            sessionId,
            viewId: `view-${sessionId}`,
            reference,
            workspacePath:
              workspacePath ??
              (reference === "readme.md" ? "src/readme.md" : reference),
            name: reference,
            mimeType: "application/octet-stream",
            size: 12,
            kind: "binary",
          },
        };
      }
      if (url.startsWith("/api/resources/probe")) {
        const { references } = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: references.map((reference) => ({
              reference,
              availability: "available",
              workspacePath: change.path.workspacePath,
            })),
          },
        };
      }
      if (url.startsWith("/api/files/list"))
        return { body: { entries: [], truncated: false } };
      return baseRoutes(url, init);
    });
  });

  it("reuses a mapped file reference and order, preserving the net Git view across tab selection", async () => {
    const { store } = await initStore();
    await store.openResource("readme.md");
    await store.openResource("other.txt");
    await store.openGitDiff(change.path.id, "worktree");
    expect(store.getState()).toMatchObject({
      contextMode: "files",
      selectedResourceReference: "readme.md",
      resourceTabs: [
        {
          reference: "readme.md",
          workspacePath: "src/readme.md",
          view: "changes",
          git: { side: "worktree" },
        },
        { reference: "other.txt" },
      ],
      gitDiff: { status: "ready", result: { side: "worktree" } },
    });
    await store.selectResourceTab("other.txt");
    await store.selectResourceTab("readme.md");
    expect(diffs.at(-1)).toEqual({ pathId: change.path.id, side: "worktree" });
    await store.openWorkspaceFile("src/readme.md");
    expect(store.getState().resourceTabs).toHaveLength(2);
    expect(store.getState().resourceTabs[0].view).toBeUndefined();
    expect(store.getState().selectedResourceReference).toBe("readme.md");
    expect(store.getState().gitDiff).toBeNull();
  });

  it.each(["./src/readme.md", "/demo/src/readme.md"])(
    "reuses a Git tab when Recent opens the authorized alias %s",
    async (reference) => {
      const { store } = await initStore();
      await store.openGitDiff(change.path.id, "worktree");
      await store.probeResources([reference]);
      expect(store.getState().resourceWorkspacePaths[reference]).toBe(
        change.path.workspacePath,
      );
      await store.openResource(reference);
      expect(store.getState().resourceTabs).toMatchObject([
        { reference: "src/readme.md", workspacePath: "src/readme.md" },
      ]);
      expect(store.getState().resourceTabs).toHaveLength(1);
      expect(store.getState().resourceTabs[0].view).toBeUndefined();
      expect(store.getState().selectedResourceReference).toBe("src/readme.md");
      expect(resolved).toEqual(["src/readme.md", "src/readme.md"]);
    },
  );

  it("restores the net comparison after closing the neighboring tab and reopening the pane", async () => {
    const { store } = await initStore();
    await store.openGitDiff(change.path.id, "worktree");
    await store.openResource("other.txt");
    store.closeResourceTab("other.txt");
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { side: "worktree" },
      }),
    );
    const previousDiff = store.getState().gitDiff;
    store.setResourcesOpen(false);
    expect(store.getState().gitDiff).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
    store.setResourcesOpen(true);
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { side: "worktree" },
      }),
    );
    expect(store.getState().gitDiff).not.toBe(previousDiff);
    expect(store.getState().resourceTabs).toHaveLength(1);
  });

  it("reloads a persisted Git tab with fresh authority and keeps its net comparison", async () => {
    const { store: first } = await initStore();
    await first.openGitDiff(change.path.id, "worktree");
    await vi.waitFor(() =>
      expect(first.getState().resourcePreview?.status).toBe("ready"),
    );
    const oldPreview = first.getState().resourcePreview;
    const { store: second } = await initStore();
    await vi.waitFor(() =>
      expect(second.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { side: "worktree" },
      }),
    );
    await vi.waitFor(() =>
      expect(second.getState().resourcePreview?.status).toBe("ready"),
    );
    expect(second.getState().resourceTabs).toMatchObject([
      {
        reference: "src/readme.md",
        view: "changes",
        git: { side: "worktree" },
      },
    ]);
    expect(second.getState().resourcePreview).not.toEqual(oldPreview);
    expect(diffs).toHaveLength(2);
    expect(JSON.stringify(sessionStorage)).not.toContain("fresh-");
  });

  it("restores an older staged tab as the net comparison while preserving a BODY tab", async () => {
    const { store: first } = await initStore();
    await first.openResource("other.txt");
    await first.openGitDiff(change.path.id);
    const key = Object.keys(sessionStorage).find((key) => {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      return Array.isArray(saved?.resourceTabs);
    })!;
    const saved = JSON.parse(sessionStorage.getItem(key)!);
    saved.resourceTabs[1].git.side = "staged";
    sessionStorage.setItem(key, JSON.stringify(saved));

    const { store: second } = await initStore();
    await vi.waitFor(() =>
      expect(second.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { side: "worktree" },
      }),
    );
    expect(second.getState().resourceTabs[1].git?.side).toBe("worktree");
    await second.selectResourceTab("other.txt");
    expect(second.getState().resourceTabs[0].view).toBeUndefined();
    expect(second.getState().resourcePreview).toMatchObject({
      status: "ready",
      reference: "other.txt",
    });
    expect(second.getState().gitDiff).toBeNull();
  });

  it("keeps a Git tab when changes cancel out and resumes the net comparison after new edits", async () => {
    const { store } = await initStore();
    await store.openGitDiff(change.path.id);
    status = repository([]);

    await store.refreshFileTab();

    expect(store.getState()).toMatchObject({
      selectedGitPathId: null,
      selectedGitSide: null,
      gitDiff: null,
      selectedResourceReference: "src/readme.md",
    });
    expect(store.getState().resourceTabs).toMatchObject([
      {
        reference: "src/readme.md",
        view: "changes",
        git: { side: "worktree" },
      },
    ]);
    status = repository([change]);
    await store.refreshGitStatus();
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { side: "worktree" },
    });
    expect(store.getState().resourceTabs).toHaveLength(1);
  });

  it("opens deleted and opaque Git paths without using display names as body authority", async () => {
    const deleted: GitFileChange = {
      path: {
        id: "deleted",
        display: "deleted.txt",
        utf8Path: "deleted.txt",
        workspacePath: "deleted.txt",
      },
      staged: { kind: "deleted" },
      worktree: { kind: "deleted" },
      untracked: false,
    };
    const opaque: GitFileChange = {
      path: { id: "opaque", display: "escaped-name" },
      unstaged: { kind: "modified" },
      worktree: { kind: "modified" as const },
      untracked: false,
    };
    status = repository([deleted, opaque]);
    const { store } = await initStore();
    await store.openGitDiff(deleted.path.id, "worktree");
    await vi.waitFor(() =>
      expect(store.getState().resourcePreview).toMatchObject({
        status: "error",
        message: "File was deleted",
      }),
    );
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: deleted.path },
    });
    await store.openGitDiff(opaque.path.id);
    expect(store.getState().selectedResourceReference).toBe("pi-git://opaque");
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: opaque.path },
    });
    await store.setFileChangesView(false);
    expect(store.getState().resourcePreview).toMatchObject({
      status: "error",
      reference: "pi-git://opaque",
    });
    expect(resolved).toEqual(["deleted.txt"]);
  });

  it("distinguishes failed status from a confirmed clean file without retaining another comparison", async () => {
    const { store } = await initStore();
    await store.openGitDiff(change.path.id);
    await store.setFileChangesView(false);
    statusFailure = true;
    await store.setFileChangesView(true);
    expect(store.getState()).toMatchObject({
      gitStatusError: "Git unavailable",
      gitDiff: null,
    });
    expect(store.getState().resourceTabs[0].view).toBe("changes");
    statusFailure = false;
    status = repository([]);
    await store.refreshFileTab();
    expect(store.getState()).toMatchObject({
      gitStatusError: null,
      gitStatus: { files: [] },
      gitDiff: null,
    });
    expect(diffs).toHaveLength(1);
    status = repository([change]);
    await store.refreshGitStatus();
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: change.path },
    });
  });

  it.each([false, true])(
    "keeps a closed pane empty after a delayed Git status settles (failure: %s)",
    async (failure) => {
      const { store } = await initStore();
      await store.openResource("readme.md");
      const pending = deferred<void>();
      statusWait = pending.promise;
      statusFailure = failure;
      const opening = store.setFileChangesView(true);
      store.setResourcesOpen(false);
      pending.resolve();
      await opening;
      expect(store.getState()).toMatchObject({
        resourcesOpen: false,
        resourcePreview: null,
        gitDiff: null,
      });
      expect(diffs).toEqual([]);
      expect(resolved).toEqual(["readme.md"]);
    },
  );

  it("does not let a delayed Git mode request reclaim a newer file selection", async () => {
    const { store } = await initStore();
    await store.openResource("readme.md");
    const pending = deferred<void>();
    statusWait = pending.promise;
    const opening = store.setFileChangesView(true);
    await store.openResource("other.txt");
    pending.resolve();
    await opening;
    expect(store.getState()).toMatchObject({
      selectedResourceReference: "other.txt",
      gitDiff: null,
    });
    expect(store.getState().resourceTabs[1].view).toBeUndefined();
    expect(diffs).toEqual([]);
  });
});
