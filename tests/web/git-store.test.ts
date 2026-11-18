import { beforeEach, expect, it, vi } from "vitest";
import type {
  GitDiffResponse,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  deferred,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
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
const repository: GitStatusResponse = {
  kind: "repository",
  head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
  files: [readme],
  total: 1,
  conflicts: 0,
  truncated: false,
};
const binary: GitDiffResponse = { kind: "binary", path: readme.path };
async function fixture() {
  const status = vi.fn<() => RouteResponse | Promise<RouteResponse>>(() => ({
    body: repository,
  }));
  const diff = vi.fn(() => ({ body: binary }));
  const alias = deferred<void>();
  let holdAlias = false;
  async function resolve(body: Record<string, unknown>) {
    const { reference, workspacePath, sessionId } = body;
    if (reference === "readme.md" && holdAlias) await alias.promise;
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
  }
  installStoreRoutes((url, init) => {
    if (url.startsWith("/api/git/status?")) return status();
    if (url === "/api/git/diff") return diff();
    if (url === "/api/resources/resolve") return resolve(jsonBody(init));
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
    alias,
    holdAlias: () => {
      holdAlias = true;
    },
  };
}

beforeEach(() => installFakeWebSocket());

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
      gitDiff: { status: "ready", result: binary },
    }),
  );
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
    pending.resolve({ body: repository });
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
