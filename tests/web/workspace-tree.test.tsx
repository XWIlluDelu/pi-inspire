// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkspaceTree } from "../../src/components/WorkspaceBrowser";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

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
              unstaged: { kind: "modified" },
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
  expect(within(rootFile).queryByLabelText(/unstaged/)).not.toBeInTheDocument();
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
  expect(within(nested).getByLabelText("unstaged modified")).toHaveTextContent(
    "M",
  );
  expect(within(nested).getByLabelText("unstaged modified")).toHaveClass(
    "git-deco--modified",
  );
  expect(nested.querySelector(".workspace-tree__name")).toHaveClass(
    "git-deco--modified",
  );
});
