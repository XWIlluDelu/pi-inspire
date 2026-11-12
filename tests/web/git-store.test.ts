import { act, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import { AppTopbar } from "../../src/components/AppTopbar";
import { inspectedPreview } from "../../src/resource-preview";
import { store as appStore } from "../../src/store";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

const path = {
  id: "ZmlsZS50eHQ",
  display: "file.txt",
  utf8Path: "file.txt",
  workspacePath: "file.txt",
};

function repository(
  files: GitFileChange[],
): Extract<GitStatusResponse, { kind: "repository" }> {
  return {
    kind: "repository",
    head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
    files,
    total: files.length,
    truncated: false,
  };
}

const initialStatus = repository([
  {
    path,
    staged: { kind: "modified" },
    unstaged: { kind: "modified" },
    worktree: { kind: "modified" },
    untracked: false,
  },
]);

function textDiff(text: string): GitDiffResponse {
  return {
    kind: "text",
    path,
    truncated: false,
    encodingLossy: false,
    additions: 1,
    deletions: 0,
    lines: [{ kind: "add", text, oldLine: null, newLine: 1 }],
  };
}

describe("Git inspection ownership and freshness", () => {
  beforeEach(() => installFakeWebSocket());

  it("keeps one topbar Git observation across session identity remounts", async () => {
    let statusCalls = 0;
    let status: GitStatusResponse = initialStatus;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) {
        statusCalls += 1;
        return { body: status };
      }
      if (url === "/api/sessions/open")
        return {
          body: activeSnapshot({ sessionId: jsonBody(init).id as string }),
        };
      return baseRoutes(url, init);
    });
    await act(async () => appStore.init());
    const noop = () => {};
    render(
      createElement(AppTopbar, {
        narrowViewport: false,
        mobileNavOpen: false,
        settingsOpen: false,
        onToggleNavigation: noop,
        onOpenCommandPalette: noop,
        onExportSession: noop,
        onToggleSettings: noop,
        onToggleResources: noop,
      }),
    );
    await waitFor(() =>
      expect(appStore.getState().gitStatus).toEqual(initialStatus),
    );
    expect(statusCalls).toBe(1);

    for (const [index, id] of ["s2", "s3"].entries()) {
      status = id === "s3" ? { kind: "not-repository" } : initialStatus;
      await act(async () => {
        await appStore.openSession(id);
      });
      await waitFor(() =>
        expect(appStore.getState().gitStatus).toEqual(status),
      );
      expect(appStore.getState().sessionId).toBe(id);
      expect(statusCalls).toBe(index + 2);
    }
  });

  it("revalidates an open comparison after reconnect and retires it when the session changes", async () => {
    const started = deferred<void>();
    const lateStatus = deferred<RouteResponse>();
    const diffStarted = deferred<AbortSignal | null | undefined>();
    const lateDiff = deferred<RouteResponse>();
    let transport = "old";
    let blockStatus = false;
    let blockDiff = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) {
        if (transport === "old" && blockStatus) {
          started.resolve();
          return lateStatus.promise;
        }
        return {
          body: {
            ...initialStatus,
            head: { ...initialStatus.head, name: transport },
          },
        };
      }
      if (url.startsWith("/api/git/diff")) {
        if (blockDiff) {
          diffStarted.resolve(init.signal);
          return lateDiff.promise;
        }
        return { body: textDiff(transport) };
      }
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "s2", cwd: "/other" }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.openGitDiff(path.id);
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: textDiff("old"),
    });
    blockStatus = true;
    const refreshing = store.refreshGitStatus();
    await started.promise;

    transport = "replacement";
    await store.init();
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({
        gitStatus: { head: { name: "replacement" } },
        gitDiff: { status: "ready", result: textDiff("replacement") },
      }),
    );

    lateStatus.resolve({ body: initialStatus });
    await refreshing;
    expect(store.getState()).toMatchObject({
      gitStatus: { head: { name: "replacement" } },
      gitDiff: { status: "ready", result: textDiff("replacement") },
    });

    blockDiff = true;
    const opening = store.openGitDiff(path.id);
    const signal = await diffStarted.promise;
    await store.openSession("s2");
    expect(signal?.aborted).toBe(true);
    lateDiff.resolve({ body: textDiff("previous session") });
    await opening;
    expect(store.getState()).toMatchObject({
      sessionId: "s2",
      gitStatus: null,
      gitDiff: null,
      fileInspection: { kind: "browse" },
    });
  });
});

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

describe("shared Files and Changes tabs", () => {
  let status: GitStatusResponse;
  let statusFailure: boolean;
  let statusWait: Promise<void> | null;
  let aliasWait: Promise<void> | null;
  let aliasSignal: AbortSignal | null | undefined;
  let resolved: string[];
  let diffs: Array<{ pathId: string }>;

  beforeEach(() => {
    installFakeWebSocket();
    status = repository([change]);
    statusFailure = false;
    statusWait = null;
    aliasWait = null;
    aliasSignal = undefined;
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
        if (reference === "readme.md" && aliasWait) {
          aliasSignal = init.signal;
          await aliasWait;
        }
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
      if (url.startsWith("/api/files/list"))
        return { body: { entries: [], truncated: false } };
      return baseRoutes(url, init);
    });
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

  it("opens deleted and opaque Git paths while retiring a late Files read", async () => {
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
    const pending = deferred<void>();
    aliasWait = pending.promise;
    const staleRead = store.openResource("readme.md");
    await vi.waitFor(() => expect(resolved).toEqual(["readme.md"]));
    await store.openGitDiff(deleted.path.id);
    expect(aliasSignal?.aborted).toBe(true);
    pending.resolve();
    await staleRead;
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
    expect(resolved).toEqual(["readme.md", "deleted.txt"]);
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

  it.each(["closes the pane", "selects another file"] as const)(
    "retires a delayed Git mode request when the reader %s",
    async (transition) => {
      const { store } = await initStore();
      await store.openResource("readme.md");
      const pending = deferred<void>();
      statusWait = pending.promise;
      statusFailure = transition === "closes the pane";
      const opening = store.setFileChangesView(true);
      if (statusFailure) store.setResourcesOpen(false);
      else await store.openResource("other.txt");
      pending.resolve();
      await opening;
      expect(store.getState()).toMatchObject({
        gitDiff: null,
        ...(statusFailure
          ? {
              resourcesOpen: false,
              fileInspection: { kind: "file", preview: null },
            }
          : { fileInspection: { kind: "file", reference: "other.txt" } }),
      });
      expect(diffs).toEqual([]);
    },
  );
});
