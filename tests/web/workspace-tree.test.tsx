// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GitFileChange } from "../../shared/contracts";
import {
  WorkspaceFileSearch,
  WorkspaceSearchResults,
  WorkspaceTree,
} from "../../src/components/WorkspaceBrowser";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  type RouteResponse,
} from "./helpers";

async function workspaceHarness() {
  const directory = vi.fn(
    (dir: string): RouteResponse | Promise<RouteResponse> => ({
      body: {
        entries: dir
          ? [{ name: "nested.ts", type: "file" }]
          : [
              { name: "known.ts", type: "file" },
              { name: "src", type: "dir" },
            ],
      },
    }),
  );
  const search = vi.fn((): RouteResponse | Promise<RouteResponse> => ({
    body: { files: [{ name: "known.ts", path: "known.ts" }] },
  }));
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({ sessionId: "s1", cwd: "/project" }),
        }),
      };
    if (url.startsWith("/api/files/list"))
      return directory(
        new URL(url, "http://local").searchParams.get("dir") ?? "",
      );
    if (url.startsWith("/api/files")) return search();
    return undefined;
  });
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  const openProject = (sessionId: string, cwd: string) =>
    act(() =>
      socket.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId, cwd }),
      }),
    );
  return { directory, search, openProject };
}

it("keeps workspace search clearing available while loading and retires the pending result", async () => {
  const harness = await workspaceHarness();
  const pending = deferred<RouteResponse>();
  harness.search.mockReturnValueOnce(pending.promise);
  render(<WorkspaceFileSearch />);
  const search = screen.getByRole("searchbox", {
    name: "Search workspace files",
  });
  fireEvent.change(search, { target: { value: "pending" } });
  await screen.findByLabelText("Searching workspace");
  fireEvent.keyDown(search, { key: "Escape", isComposing: true });
  expect(search).toHaveValue("pending");
  const clear = screen.getByRole("button", { name: "Clear workspace search" });
  expect(clear).toBeEnabled();
  fireEvent.click(clear);
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  await act(async () =>
    pending.resolve({
      body: { files: [{ name: "pending.ts", path: "pending.ts" }] },
    }),
  );
  expect(store.getState().workspaceQuery).toBe("");
  expect(store.getState().workspaceMatches).toEqual([]);
  expect(
    screen.queryByLabelText("Searching workspace"),
  ).not.toBeInTheDocument();
});

it("preserves displayed files through a failed refresh and clears its warnings on return", async () => {
  const harness = await workspaceHarness();
  await store.loadWorkspaceDirectory("");
  store.setWorkspaceQuery("known");
  await vi.waitFor(() =>
    expect(store.getState().workspaceSearchLoading).toBe(false),
  );
  render(
    <>
      <WorkspaceTree />
      <WorkspaceSearchResults />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "src" }));
  await screen.findByRole("button", { name: "nested.ts" });
  const pending = deferred<RouteResponse>();
  const failure = { status: 403, body: { error: "Directory unavailable" } };
  harness.directory
    .mockReturnValueOnce(pending.promise)
    .mockReturnValue(failure);
  harness.search.mockReturnValue({
    status: 403,
    body: { error: "Search unavailable" },
  });
  let refresh!: Promise<void>;
  act(() => {
    refresh = store.refreshWorkspaceBrowser();
  });
  expect(screen.getAllByRole("button", { name: /^known\.ts/ })).toHaveLength(2);
  await act(async () => {
    pending.resolve(failure);
    await refresh;
  });
  expect(screen.getAllByText("Directory could not be refreshed")).toHaveLength(
    2,
  );
  expect(screen.getByText("Search unavailable")).toBeVisible();
  expect(screen.getByRole("button", { name: "nested.ts" })).toBeVisible();

  harness.openProject("other", "/other");
  await screen.findByText("Directory unavailable");
  expect(screen.queryByRole("button", { name: "nested.ts" })).toBeNull();
  harness.directory.mockImplementation((dir) => ({
    body: {
      entries: dir
        ? [{ name: "new.ts", type: "file" }]
        : [{ name: "src", type: "dir" }],
    },
  }));
  harness.search.mockReturnValue({
    body: { files: [{ name: "new.ts", path: "src/new.ts" }] },
  });
  harness.openProject("s1", "/project");
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /^new\.ts/ })).toHaveLength(2),
  );
  expect(screen.queryByRole("button", { name: "nested.ts" })).toBeNull();
  expect(screen.queryByText("Directory could not be refreshed")).toBeNull();
  expect(screen.queryByText("Search unavailable")).toBeNull();
});

it("rolls up only authorized Git paths and decorates the exact file, not a basename match", async () => {
  const folders = ["other", "others", "clash", "opaque", "vendor"];
  const file = (
    display: string,
    change: Omit<GitFileChange, "path" | "untracked"> & { untracked?: boolean },
    workspacePath: string | null = display,
  ): GitFileChange => ({
    path: { id: display, display, workspacePath: workspacePath ?? undefined },
    untracked: false,
    ...change,
  });
  const files = [
    file("other/changed.ts", { worktree: { kind: "modified" } }),
    file("other/untracked.ts", { untracked: true }),
    file("clash/deep/merge.ts", { conflict: { code: "UU" } }),
    file("clash/change.ts", { worktree: { kind: "modified" } }),
    file("clash/new.ts", { untracked: true }),
    file("others-shadow/twin.ts", { worktree: { kind: "modified" } }),
    file("opaque/not-safe.ts", { untracked: true }, null),
    file("vendor", { worktree: { kind: "modified" } }),
    file("canceled.ts", {
      staged: { kind: "added" },
      unstaged: { kind: "deleted" },
    }),
  ];
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({ sessionId: "alpha", cwd: "/work/alpha" }),
        }),
      };
    if (url.startsWith("/api/git/status"))
      return {
        body: {
          kind: "repository",
          head: { kind: "branch", name: "main", oid: "abc" },
          files,
          total: files.length,
          truncated: false,
        },
      };
    if (url.startsWith("/api/files/list")) {
      const dir = new URL(url, "http://local").searchParams.get("dir");
      return {
        body: {
          entries:
            dir === "other"
              ? [{ name: "changed.ts", type: "file" }]
              : [
                  ...folders.map((name) => ({ name, type: "dir" })),
                  { name: "changed.ts", type: "file" },
                  { name: "canceled.ts", type: "file" },
                ],
        },
      };
    }
  });
  await store.init();
  await store.refreshGitStatus();
  render(<WorkspaceTree />);
  await screen.findByRole("button", { name: "changed.ts" });
  for (const name of ["opaque", "others", "canceled.ts"]) {
    expect(screen.getByRole("button", { name })).toBeVisible();
  }
  expect(
    screen.getByRole("button", { name: /^vendor.*Contains modified files/i }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /^clash.*Contains conflicts/i }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: /^other.*Contains modified files/i }),
  );
  const changed = await screen.findByRole("button", {
    name: /^changed\.ts.*modified/,
  });
  expect(
    within(changed).getByRole("img", { name: "modified" }),
  ).toHaveTextContent("M");
});
