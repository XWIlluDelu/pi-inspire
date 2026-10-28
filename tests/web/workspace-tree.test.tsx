// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => vi.useRealTimers());

async function workspaceHarness() {
  const directory = vi.fn(
    (dir: string): RouteResponse => ({
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
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { directory, search, socket };
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

it("keeps confirmed directory and search rows visible during and after a failed refresh", async () => {
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
  expect(screen.getAllByRole("button", { name: /^known\.ts/ })).toHaveLength(2);
  harness.directory.mockReturnValue({
    status: 503,
    body: { error: "Directory temporarily unavailable" },
  });
  harness.search.mockReturnValue({
    status: 503,
    body: { error: "Search temporarily unavailable" },
  });
  vi.useFakeTimers();
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = store.refreshWorkspaceBrowser();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getAllByRole("button", { name: /^known\.ts/ })).toHaveLength(2);
  expect(screen.queryByText("Loading…")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(28_000));
  await refresh;
  expect(screen.getAllByRole("button", { name: /^known\.ts/ })).toHaveLength(2);
  expect(screen.getByText("Directory could not be refreshed")).toBeVisible();
  expect(screen.getByText("Search temporarily unavailable")).toBeVisible();
  expect(screen.queryByText("Directory unavailable")).toBeNull();
});

it("revalidates cached failed visible directories when returning to a workspace", async () => {
  const harness = await workspaceHarness();
  render(<WorkspaceTree />);
  fireEvent.click(await screen.findByRole("button", { name: "src" }));
  await screen.findByRole("button", { name: "nested.ts" });
  harness.directory.mockReturnValue({
    status: 403,
    body: { error: "Permission denied" },
  });
  await act(() => store.refreshWorkspaceBrowser());
  expect(store.getState().workspaceDirectoryErrors).toEqual({
    "": "Permission denied",
    src: "Permission denied",
  });
  act(() =>
    harness.socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "other",
        cwd: "/other",
      }),
    }),
  );
  await screen.findByText("Directory unavailable");
  harness.directory.mockReturnValue({
    body: { entries: [{ name: "new.ts", type: "file" }] },
  });
  harness.directory.mockClear();
  act(() =>
    harness.socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "s1",
        cwd: "/project",
      }),
    }),
  );
  await screen.findByRole("button", { name: "new.ts" });
  expect(harness.directory.mock.calls.map(([dir]) => dir)).toEqual(["", "src"]);
  expect(store.getState().workspaceDirectoryErrors).toEqual({});
});

it("decorates workspace rows by exact path without basename guessing", async () => {
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
          head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
          files: [
            {
              path: {
                id: "b3RoZXIvY2hhbmdlZC50cw",
                display: "other/changed.ts",
                utf8Path: "other/changed.ts",
                workspacePath: "other/changed.ts",
              },
              worktree: { kind: "modified" },
              untracked: false,
            },
          ],
          total: 1,
          truncated: false,
          groups: {
            conflicted: [],
            staged: [],
            unstaged: ["b3RoZXIvY2hhbmdlZC50cw"],
            untracked: [],
          },
        },
      };
    if (url.startsWith("/api/files/list")) {
      const dir = new URL(url, "http://local").searchParams.get("dir") ?? "";
      return {
        body: {
          entries:
            dir === "other"
              ? [{ name: "changed.ts", type: "file" }]
              : [
                  { name: "other", type: "dir" },
                  { name: "changed.ts", type: "file" },
                ],
        },
      };
    }

    return undefined;
  });
  await store.init("token");
  await store.refreshGitStatus();
  render(<WorkspaceTree />);
  const rootFile = await screen.findByRole("button", { name: "changed.ts" });
  expect(within(rootFile).queryByLabelText("modified")).not.toBeInTheDocument();
  expect(rootFile.querySelector(".workspace-tree__name")).not.toHaveClass(
    "git-deco--modified",
  );
  const dirtyDirectory = screen.getByRole("button", {
    name: /other.*contains modified files/i,
  });
  expect(dirtyDirectory.querySelector(".workspace-tree__name")).toHaveClass(
    "git-deco--modified",
  );
  expect(
    within(dirtyDirectory).getByLabelText("Contains modified files"),
  ).toHaveClass("git-rollup", "git-deco--modified");
  fireEvent.click(dirtyDirectory);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /changed\.ts/ })).toHaveLength(
      2,
    ),
  );
  const files = screen.getAllByRole("button", { name: /changed\.ts/ });
  const nested = files.find((button) => button !== rootFile)!;
  expect(within(nested).getByLabelText("modified")).toHaveTextContent("M");
  expect(within(nested).getByLabelText("modified")).toHaveClass(
    "git-deco--modified",
  );
  expect(nested.querySelector(".workspace-tree__name")).toHaveClass(
    "git-deco--modified",
  );
});
