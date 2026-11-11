import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitStatusResponse } from "../../shared/contracts";
import { inspectedPreview } from "../../src/resource-preview";
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
  };
}

describe("ordinary file tabs with Git views", () => {
  let status: GitStatusResponse;
  let statusFailure: boolean;
  let statusWait: Promise<void> | null;
  let aliasWait: Promise<void> | null;
  let resolved: string[];
  let diffs: Array<{ pathId: string }>;

  beforeEach(() => {
    installFakeWebSocket();
    status = repository([change]);
    statusFailure = false;
    statusWait = null;
    aliasWait = null;
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
        const { pathId } = jsonBody(init);
        diffs.push({ pathId: String(pathId) });
        const file =
          status.kind === "repository"
            ? status.files.find((file) => file.path.id === pathId)
            : undefined;
        return { body: { kind: "binary", path: file?.path } };
      }
      if (url.startsWith("/api/resources/resolve")) {
        const { reference, workspacePath, sessionId } = jsonBody(init);
        resolved.push(String(reference));
        if (reference === "readme.md" && aliasWait) await aliasWait;
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
    await store.openGitDiff(change.path.id);
    expect(store.getState()).toMatchObject({
      contextMode: "files",
      fileInspection: { kind: "file", reference: "readme.md" },
      resourceTabs: [
        {
          reference: "readme.md",
          workspacePath: "src/readme.md",
          view: "changes",
          git: { pathId: change.path.id },
        },
        { reference: "other.txt" },
      ],
      gitDiff: { status: "ready", result: { path: change.path } },
    });
    await store.selectResourceTab("other.txt");
    await store.selectResourceTab("readme.md");
    expect(diffs.at(-1)).toEqual({ pathId: change.path.id });
    await store.openWorkspaceFile("src/readme.md");
    expect(store.getState().resourceTabs).toHaveLength(2);
    expect(store.getState().resourceTabs[0].view).toBeUndefined();
    expect(store.getState().fileInspection.reference).toBe("readme.md");
    expect(store.getState().gitDiff).toBeNull();
  });

  it("reuses a Git tab when Recent opens an alias with a known path", async () => {
    const { store } = await initStore();
    const reference = "./src/readme.md";
    await store.openGitDiff(change.path.id);
    await store.probeResources([reference]);
    await store.openResource(reference);
    expect(store.getState().resourceTabs).toMatchObject([
      { reference: "src/readme.md", workspacePath: "src/readme.md" },
    ]);
    expect(store.getState().resourceTabs[0].view).toBeUndefined();
    expect(store.getState().fileInspection.reference).toBe("src/readme.md");
    expect(resolved).toEqual(["src/readme.md", "src/readme.md"]);
  });

  it("keeps Changes selected when a pending alias resolves to an existing tab", async () => {
    const { store } = await initStore();
    await store.openWorkspaceFile("src/readme.md");
    await store.openWorkspaceFile("other.txt");
    const pending = deferred<void>();
    aliasWait = pending.promise;
    const body = store.openResource("readme.md");
    await store.setFileChangesView(true);
    expect(diffs).toEqual([]);

    pending.resolve();
    await body;

    expect(store.getState().resourceTabs).toMatchObject([
      { reference: "src/readme.md", view: "changes" },
      { reference: "other.txt" },
    ]);
    expect(store.getState().fileInspection).toMatchObject({
      kind: "file",
      reference: "src/readme.md",
      workspacePath: "src/readme.md",
    });
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { path: change.path },
      }),
    );
  });

  it("restores the net comparison after closing the neighboring tab and reopening the pane", async () => {
    const { store } = await initStore();
    await store.openGitDiff(change.path.id);
    await store.openResource("other.txt");
    store.closeResourceTab("other.txt");
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { path: change.path },
      }),
    );
    const previousDiff = store.getState().gitDiff;
    store.setResourcesOpen(false);
    expect(store.getState().gitDiff).toBeNull();
    expect(inspectedPreview(store.getState().fileInspection)).toBeNull();
    store.setResourcesOpen(true);
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { path: change.path },
      }),
    );
    expect(store.getState().gitDiff).not.toBe(previousDiff);
    expect(store.getState().resourceTabs).toHaveLength(1);
  });

  it("reloads a persisted Git tab with fresh authority and keeps its net comparison", async () => {
    const { store: first } = await initStore();
    await first.openGitDiff(change.path.id);
    await vi.waitFor(() =>
      expect(inspectedPreview(first.getState().fileInspection)?.status).toBe(
        "ready",
      ),
    );
    const oldPreview = inspectedPreview(first.getState().fileInspection);
    const { store: second } = await initStore();
    await vi.waitFor(() =>
      expect(second.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { path: change.path },
      }),
    );
    await vi.waitFor(() =>
      expect(inspectedPreview(second.getState().fileInspection)?.status).toBe(
        "ready",
      ),
    );
    expect(second.getState().resourceTabs).toMatchObject([
      {
        reference: "src/readme.md",
        view: "changes",
        git: { pathId: change.path.id },
      },
    ]);
    expect(inspectedPreview(second.getState().fileInspection)).not.toEqual(
      oldPreview,
    );
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
        result: { path: change.path },
      }),
    );
    expect(second.getState().resourceTabs[1].git?.pathId).toBe(change.path.id);
    await second.selectResourceTab("other.txt");
    expect(second.getState().resourceTabs[0].view).toBeUndefined();
    expect(inspectedPreview(second.getState().fileInspection)).toMatchObject({
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
      gitDiff: null,
      fileInspection: { kind: "file", reference: "src/readme.md" },
    });
    expect(store.getState().resourceTabs).toMatchObject([
      {
        reference: "src/readme.md",
        view: "changes",
        git: { pathId: change.path.id },
      },
    ]);
    status = repository([change]);
    await store.refreshGitStatus();
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: change.path },
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
    await store.openGitDiff(deleted.path.id);
    await vi.waitFor(() =>
      expect(inspectedPreview(store.getState().fileInspection)).toMatchObject({
        status: "error",
        message: "File was deleted",
      }),
    );
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: deleted.path },
    });
    await store.openGitDiff(opaque.path.id);
    expect(store.getState().fileInspection.reference).toBe("pi-git://opaque");
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { path: opaque.path },
    });
    await store.setFileChangesView(false);
    expect(inspectedPreview(store.getState().fileInspection)).toMatchObject({
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
        fileInspection: { kind: "file", preview: null },
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
      fileInspection: { kind: "file", reference: "other.txt" },
      gitDiff: null,
    });
    expect(store.getState().resourceTabs[1].view).toBeUndefined();
    expect(diffs).toEqual([]);
  });
});
