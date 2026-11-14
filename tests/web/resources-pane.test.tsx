// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { stripResourceLocation } from "../../shared/resource-references";
import { ContextPane } from "../../src/components/ContextPane";
import { Notices } from "../../src/components/Notices";
import { store } from "../../src/store";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
} from "./helpers";
import { installStoreRoutes } from "./store-fixture";

const notes = {
  id: "notes",
  display: "notes.md",
  utf8Path: "notes.md",
  workspacePath: "notes.md",
};
const markdown = "# Previewed notes\n\nThird line\nFourth line";

describe("Files pane", () => {
  let gitStatusGate: Promise<void> | null;
  let resourceListGate: Promise<void> | null;
  let transcriptRevision: number;
  let resourceListHead: string;
  let unavailable: boolean;
  let requests: (
    path: string,
  ) => ReturnType<typeof installStoreRoutes>["mock"]["calls"];

  beforeEach(async () => {
    gitStatusGate = resourceListGate = null;
    transcriptRevision = 1;
    resourceListHead = "notes.md";
    unavailable = false;
    installFakeWebSocket();
    const fetch = installStoreRoutes(async (url, init) => {
      const { pathname, searchParams } = new URL(url, "http://fixture.local");
      const address = {
        sessionId: "s1",
        viewId: "view-s1",
        revision: transcriptRevision,
      };
      switch (pathname) {
        case "/api/files/list":
          return {
            body: {
              entries: searchParams.get("dir")
                ? []
                : [
                    { name: "src", type: "dir" },
                    { name: "README.md", type: "file" },
                  ],
            },
          };
        case "/api/git/status":
          await gitStatusGate;
          return {
            body: {
              kind: "repository",
              head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
              files: [
                {
                  path: notes,
                  worktree: { kind: "modified" },
                  untracked: false,
                },
              ],
              total: 1,
              truncated: false,
            },
          };
        case "/api/git/diff":
          return {
            body: {
              path: notes,
              kind: "text",
              additions: 1,
              deletions: 0,
              lines: [{ kind: "add", text: "+new", oldLine: null, newLine: 1 }],
            },
          };
        case "/api/resources/list":
          await resourceListGate;
          return {
            body: {
              ...address,
              produced: [],
              resources: [resourceListHead, "demo.html", "old-1.md"].map(
                (reference) => ({
                  key: reference,
                  reference,
                  label: reference,
                  source: "link",
                }),
              ),
            },
          };
        case "/api/resources/probe":
          return {
            body: {
              ...address,
              results: (jsonBody(init).references as string[]).map(
                (reference) => ({
                  reference,
                  ...(unavailable && reference === "demo.html"
                    ? {
                        availability: "missing",
                        message: "The referenced file was not found",
                      }
                    : unavailable && reference === "old-1.md"
                      ? {
                          availability: "invalid",
                          message: "The reference is not a file",
                        }
                      : {
                          availability: "available",
                          workspacePath: stripResourceLocation(reference),
                        }),
                }),
              ),
            },
          };
        case "/api/resources/resolve": {
          const { reference, workspacePath } = jsonBody(init) as {
            reference: string;
            workspacePath?: string;
          };
          const path = workspacePath ?? stripResourceLocation(reference);
          if (path === "./folder" || path === "folder")
            return {
              status: 400,
              body: { error: "The reference is not a file" },
            };
          return {
            body: fakeResourceDescriptor(reference, {
              id: "notes",
              workspacePath: path,
              name: path,
              kind: "markdown",
              mimeType: "text/markdown",
              size: markdown.length,
            }),
          };
        }
        case "/api/resources/notes/content":
          return new Response(markdown, {
            headers: { "Content-Type": "text/markdown" },
          });
        case "/api/resources/show-in-file-manager":
          return jsonBody(init).directory
            ? { body: { ok: true } }
            : { status: 503, body: { error: "No desktop is available" } };
      }
    });
    requests = (path) =>
      fetch.mock.calls.filter(([url]) => String(url).startsWith(path));
    store.showFileBrowser();
    for (const tab of store.getState().resourceTabs)
      store.closeResourceTab(tab.reference);
    await store.init();
    FakeWebSocket.instances.at(-1)!.join(activeSnapshot());
    store.showFileBrowser();
    store.setResourcesOpen(false);
  });

  function showContext() {
    store.setResourcesOpen(true);
    return render(<ContextPane />);
  }

  it("reveals a folder and a Recent file without leaving Files, and reports a Host refusal", async () => {
    showContext();
    render(<Notices onViewUpdates={() => {}} />);
    const folder = await screen.findByRole("button", { name: /^src$/ });
    fireEvent.click(folder, { ctrlKey: true });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(await screen.findByRole("button", { name: /^notes\.md/ }), {
      metaKey: true,
    });
    expect(await screen.findByText("No desktop is available")).toBeVisible();
    expect(
      requests("/api/resources/show-in-file-manager").map(([, init]) =>
        jsonBody(init ?? {}),
      ),
    ).toEqual([
      {
        sessionId: "s1",
        reference: "src",
        workspacePath: "src",
        directory: true,
      },
      {
        sessionId: "s1",
        reference: "notes.md",
        workspacePath: "notes.md",
        directory: false,
      },
    ]);
    expect(requests("/api/resources/resolve").length).toBe(0);
    expect(
      screen.getByRole("tab", { name: "Files", selected: true }),
    ).toBeVisible();
  });

  it("keeps Recent usable while a new revision is being resolved", async () => {
    showContext();
    const original = await screen.findByRole("button", { name: /notes\.md/ });
    const pending = deferred<void>();
    resourceListGate = pending.promise;
    resourceListHead = "replacement.md";
    transcriptRevision = 2;
    try {
      act(() =>
        FakeWebSocket.instances
          .at(-1)!
          .emitSnapshot(activeSnapshot({ transcriptPage: { revision: 2 } })),
      );
      expect(original).toBeEnabled();
    } finally {
      act(() => pending.resolve());
    }
    expect(
      await screen.findByRole("button", { name: /replacement\.md/ }),
    ).toBeVisible();
    expect(original).not.toBeInTheDocument();
  });

  it("reuses the named file tab for a line target and retains the source through an append", async () => {
    resourceListHead = "notes.md#L3";
    showContext();
    await screen.findByRole("button", { name: /^notes\.md/ });
    await act(() => store.openResource("notes.md"));
    await screen.findByRole("heading", { name: "Previewed notes" });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await waitFor(() =>
      expect(
        store.getState().resourceStanding["notes.md#L3"]?.workspacePath,
      ).toBe("notes.md"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^notes\.md/ }));
    expect(
      await screen.findByRole("region", { name: "File source" }),
    ).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "notes.md", selected: true }),
    ).toBeVisible();
    expect(store.getState().resourceTabs).toHaveLength(1);
    const listsBeforeAppend = requests("/api/resources/list").length;
    transcriptRevision = 2;
    act(() => {
      FakeWebSocket.instances.at(-1)?.emitSnapshot(
        activeSnapshot({
          transcriptPage: { revision: 2, appendFromRevision: 2 },
        }),
      );
    });
    await waitFor(() => expect(store.getState().view.revision).toBe(2));
    expect(screen.getByRole("region", { name: "File source" })).toBeVisible();
    expect(requests("/api/resources/list").length).toBe(listsBeforeAppend);
  });

  it("refreshes Recent and workspace files independently of a pending Git refresh", async () => {
    await store.refreshGitStatus();
    await store.openGitDiff("notes");
    render(<ContextPane />);
    const refresh = screen.getByRole("button", {
      name: "Refresh context pane",
    });
    const git = deferred<void>();
    const recent = deferred<void>();
    gitStatusGate = git.promise;
    try {
      fireEvent.click(refresh);
      expect(refresh).toBeDisabled();
      fireEvent.click(screen.getByRole("tab", { name: "Files" }));
      await screen.findByRole("button", { name: /^notes\.md/ });
      const lists = requests("/api/resources/list").length;
      const status = requests("/api/git/status").length;
      resourceListGate = recent.promise;
      fireEvent.click(refresh);
      expect(refresh).toBeDisabled();
      expect(requests("/api/resources/list")).toHaveLength(lists + 1);
      expect(requests("/api/git/status")).toHaveLength(status);
      expect(
        requests("/api/files/list").some(([url]) =>
          String(url).includes("refresh=1"),
        ),
      ).toBe(true);
      await act(async () => git.resolve());
      expect(refresh).toBeDisabled();
    } finally {
      await act(async () => {
        git.resolve();
        recent.resolve();
      });
    }
    expect(refresh).toBeEnabled();
  });

  it("marks missing Recent files, omits non-files, and offers no Retry for a direct non-file", async () => {
    unavailable = true;
    showContext();
    const missing = await screen.findByRole("button", {
      name: /demo\.html.*unavailable/i,
    });
    expect(missing).toHaveAttribute(
      "title",
      expect.stringContaining("not found"),
    );
    expect(screen.queryByRole("button", { name: /old-1\.md/ })).toBeNull();

    await act(() => store.openResource("./folder"));
    expect(
      await screen.findByText("The reference is not a file"),
    ).toBeVisible();
    expect(screen.getByText("Not a file")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
