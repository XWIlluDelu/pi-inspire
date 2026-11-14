import { beforeEach, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import { inspectedPreview } from "../../src/resource-preview";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  selectSession,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

const readme: GitFileChange = {
  path: {
    id: "src-readme",
    display: "src/readme.md",
    workspacePath: "src/readme.md",
    utf8Path: "src/readme.md",
  },
  worktree: { kind: "modified" },
  untracked: false,
};
const deleted: GitFileChange = {
  path: { id: "deleted", display: "deleted.txt", workspacePath: "deleted.txt" },
  worktree: { kind: "deleted" },
  untracked: false,
};
const opaque: GitFileChange = {
  path: { id: "opaque", display: "escaped-�" },
  worktree: { kind: "modified" },
  untracked: false,
};

const repository = (files = [readme], name = "main"): GitStatusResponse => ({
  kind: "repository",
  head: { kind: "branch", name, oid: "0123456789abcdef" },
  files,
  total: files.length,
  truncated: false,
});
const binary = ({ path }: GitFileChange): GitDiffResponse => ({
  kind: "binary",
  path,
});
const textDiff = (text: string): GitDiffResponse => ({
  kind: "text",
  path: readme.path,
  additions: 1,
  deletions: 0,
  truncated: false,
  encodingLossy: false,
  lines: [{ kind: "add", text, oldLine: null, newLine: 1 }],
});

async function fixture(files = [readme]) {
  const status = vi
    .fn<
      (signal: RequestInit["signal"]) => RouteResponse | Promise<RouteResponse>
    >()
    .mockReturnValue({ body: repository(files) });
  const diff = vi
    .fn<
      (
        pathId: unknown,
        signal: RequestInit["signal"],
      ) => RouteResponse | Promise<RouteResponse>
    >()
    .mockImplementation((id) => ({
      body: binary(files.find((file) => file.path.id === id)!),
    }));
  const alias = deferred<void>();
  let holdAlias = false;
  const resolve = vi.fn(
    async (body: Record<string, unknown>, _signal: RequestInit["signal"]) => {
      const { reference, workspacePath, sessionId } = body;
      if (reference === "readme.md" && holdAlias) await alias.promise;
      if (reference === "deleted.txt")
        return { status: 404, body: { error: "File was deleted" } };
      return {
        body: fakeResourceDescriptor(String(reference), {
          sessionId: String(sessionId),
          viewId: `view-${sessionId}`,
          workspacePath: String(
            workspacePath ??
              (reference === "readme.md" ? "src/readme.md" : reference),
          ),
          kind: "binary",
          mimeType: "application/octet-stream",
        }),
      };
    },
  );
  installStoreRoutes((url, init) => {
    if (url.startsWith("/api/git/status?")) return status(init.signal);
    if (url === "/api/git/diff")
      return diff(jsonBody(init).pathId, init.signal);
    if (url === "/api/resources/resolve")
      return resolve(jsonBody(init), init.signal);
    if (url.startsWith("/api/files/list"))
      return { body: { entries: [], truncated: false } };
  });
  const { store } = await initStore();
  const state = () => store.getState();
  return {
    store,
    state,
    status,
    diff,
    resolve,
    alias,
    holdAlias: () => {
      holdAlias = true;
    },
  };
}

beforeEach(() => installFakeWebSocket());

it("reauthorizes visible Changes on reconnect and retires reads across session selection", async () => {
  const f = await fixture();
  f.diff.mockReturnValue({ body: textDiff("old") });
  await f.store.openGitDiff(readme.path.id);
  expect(f.state().gitDiff).toMatchObject({
    status: "ready",
    result: textDiff("old"),
  });
  const started = deferred<void>();
  const oldStatus = deferred<RouteResponse>();
  f.status.mockImplementationOnce(() => {
    started.resolve();
    return oldStatus.promise;
  });
  const inspecting = f.store.refreshGitStatus();
  await started.promise;
  f.status.mockReturnValue({ body: repository([readme], "replacement") });
  f.diff.mockReturnValue({ body: textDiff("replacement") });
  await f.store.init();
  FakeWebSocket.instances.at(-1)!.join(activeSnapshot());
  const fresh = {
    gitStatus: { head: { name: "replacement" } },
    gitDiff: { status: "ready", result: textDiff("replacement") },
  };
  await vi.waitFor(() => expect(f.state()).toMatchObject(fresh));
  oldStatus.resolve({ body: repository() });
  await inspecting;
  expect(f.state()).toMatchObject(fresh);

  const opened = deferred<RequestInit["signal"]>();
  const lateDiff = deferred<RouteResponse>();
  f.diff.mockImplementationOnce((_id, signal) => {
    opened.resolve(signal);
    return lateDiff.promise;
  });
  const pending = f.store.openGitDiff(readme.path.id);
  const signal = await opened.promise;
  await selectSession(
    f.store,
    activeSnapshot({ sessionId: "s2", cwd: "/other" }),
  );
  expect(signal?.aborted).toBe(true);
  lateDiff.resolve({ body: textDiff("retired session") });
  await pending;
  expect(f.state()).toMatchObject({
    sessionId: "s2",
    gitStatus: null,
    gitDiff: null,
    fileInspection: { kind: "browse" },
  });
});

it("deduplicates the canonical tab after a late alias without changing the selected Changes mode", async () => {
  const f = await fixture();
  await f.store.openWorkspaceFile("src/readme.md");
  await f.store.openWorkspaceFile("other.txt");
  f.holdAlias();
  const reading = f.store.openResource("readme.md");
  await f.store.setFileChangesView(true);
  expect(f.diff).not.toHaveBeenCalled();
  f.alias.resolve();
  await reading;
  await vi.waitFor(() =>
    expect(f.state()).toMatchObject({
      resourceTabs: [
        { reference: "src/readme.md", view: "changes" },
        { reference: "other.txt" },
      ],
      fileInspection: {
        kind: "file",
        reference: "src/readme.md",
        workspacePath: "src/readme.md",
      },
      gitDiff: { status: "ready", result: binary(readme) },
    }),
  );
});

it("opens deleted and opaque paths as Git comparisons without guessing a filesystem name", async () => {
  const f = await fixture([deleted, opaque]);
  f.holdAlias();
  const stale = f.store.openResource("readme.md");
  await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
  await f.store.openGitDiff(deleted.path.id);
  expect(f.resolve.mock.calls[0]![1]?.aborted).toBe(true);
  f.alias.resolve();
  await stale;
  await vi.waitFor(() =>
    expect(inspectedPreview(f.state().fileInspection)).toMatchObject({
      status: "error",
      message: "File was deleted",
    }),
  );
  expect(f.state().gitDiff).toMatchObject({
    status: "ready",
    result: binary(deleted),
  });
  await f.store.openGitDiff(opaque.path.id);
  expect(f.state().gitDiff).toMatchObject({
    status: "ready",
    result: binary(opaque),
  });
  await f.store.setFileChangesView(false);
  expect(inspectedPreview(f.state().fileInspection)).toMatchObject({
    status: "error",
    reference: "pi-git://opaque",
  });
  expect(f.resolve.mock.calls.map(([body]) => body.reference)).toEqual([
    "readme.md",
    "deleted.txt",
  ]);
});

it("distinguishes failed status from a confirmed clean result while retaining Changes mode", async () => {
  const f = await fixture();
  await f.store.openGitDiff(readme.path.id);
  await f.store.setFileChangesView(false);
  f.status.mockReturnValueOnce({
    status: 503,
    body: { error: "Git unavailable" },
  });
  await f.store.setFileChangesView(true);
  expect(f.state()).toMatchObject({
    gitStatusError: "Git unavailable",
    gitDiff: null,
    resourceTabs: [{ view: "changes" }],
  });
  f.status.mockReturnValueOnce({ body: repository([]) });
  await f.store.refreshFileTab();
  expect(f.state()).toMatchObject({
    gitStatusError: null,
    gitStatus: { files: [] },
    gitDiff: null,
  });
  expect(f.diff).toHaveBeenCalledOnce();
  await f.store.refreshGitStatus();
  expect(f.state().gitDiff).toMatchObject({
    status: "ready",
    result: binary(readme),
  });
});

it.each(["close", "switch"] as const)(
  "drops deferred Changes mode on %s before a diff can start",
  async (gesture) => {
    const f = await fixture();
    await f.store.openResource("readme.md");
    const pending = deferred<RouteResponse>();
    f.status.mockReturnValueOnce(pending.promise);
    const opening = f.store.setFileChangesView(true);
    if (gesture === "close") f.store.setResourcesOpen(false);
    else await f.store.openResource("other.txt");
    pending.resolve({ body: repository() });
    await opening;
    expect(f.diff).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({
      gitDiff: null,
      ...(gesture === "close"
        ? {
            resourcesOpen: false,
            fileInspection: { kind: "file", preview: null },
          }
        : { fileInspection: { kind: "file", reference: "other.txt" } }),
    });
  },
);
