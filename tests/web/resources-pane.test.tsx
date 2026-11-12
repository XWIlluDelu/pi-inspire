// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripResourceLocation } from "../../shared/resource-references";
import { ContextPane } from "../../src/components/ContextPane";
import { Notices } from "../../src/components/Notices";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
} from "./helpers";

const source = {
  markdown: {
    kind: "markdown",
    mimeType: "text/markdown",
    text: "# Previewed notes\n\nThird line\nFourth line",
  },
  "demo.html": {
    kind: "html",
    mimeType: "text/html",
    text: "<h1>Static page</h1>",
  },
};

function fixtureFile(path: string) {
  return path in source ? (path as keyof typeof source) : "markdown";
}

describe("Files pane", () => {
  let gitStatusGate: Promise<void> | null = null;
  let missingProbeReference: string | null = null;
  let invalidProbeReference: string | null = null;
  let resourceListGate: Promise<void> | null = null;
  let transcriptRevision = 1;
  let resourceListHead: string | null = null;

  beforeEach(async () => {
    gitStatusGate = null;
    missingProbeReference = null;
    invalidProbeReference = null;
    resourceListGate = null;
    transcriptRevision = 1;
    resourceListHead = null;
    installFakeWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/bootstrap")) {
          return Response.json(
            bootstrapPayload({
              snapshot: activeSnapshot({
                transcriptPage: {
                  revision: transcriptRevision,
                  hasOlder: true,
                  olderCursor: "older-s1",
                },
              }),
            }),
          );
        }
        if (url.startsWith("/api/sessions"))
          return Response.json(sessionPage([], 0));
        if (url.startsWith("/api/files/list")) {
          const dir =
            new URL(url, "http://localhost").searchParams.get("dir") ?? "";
          return Response.json({
            entries:
              dir === "src"
                ? []
                : [
                    { name: "src", type: "dir" },
                    { name: "README.md", type: "file" },
                  ],
          });
        }
        const notesPath = {
          id: "notes",
          display: "notes.md",
          utf8Path: "notes.md",
          workspacePath: "notes.md",
        };
        if (url.startsWith("/api/git/status")) {
          const gate = gitStatusGate;
          gitStatusGate = null;
          if (gate) await gate;
          return Response.json({
            kind: "repository",
            head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
            files: [
              {
                path: notesPath,
                worktree: { kind: "modified" },
                untracked: false,
              },
            ],
            total: 1,
            truncated: false,
          });
        }
        if (url.startsWith("/api/git/diff")) {
          return Response.json({
            path: notesPath,
            kind: "text",
            additions: 1,
            deletions: 0,
            truncated: false,
            encodingLossy: false,
            lines: [{ kind: "add", text: "+new", oldLine: null, newLine: 1 }],
          });
        }
        if (url.startsWith("/api/resources/list")) {
          const responseRevision = transcriptRevision;
          const gate = resourceListGate;
          resourceListGate = null;
          if (gate) await gate;
          const resources = [
            resourceListHead ?? "notes.md",
            "demo.html",
            "old-1.md",
          ].map((reference) => ({
            key: `file:${reference}`,
            reference,
            label: reference,
            source: "link" as const,
          }));
          return Response.json({
            sessionId: "s1",
            viewId: "view-s1",
            revision: responseRevision,
            offset: 0,
            total: resources.length,
            nextCursor: null,
            resources,
          });
        }
        if (url.startsWith("/api/resources/probe")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            references: string[];
          };
          return Response.json({
            sessionId: "s1",
            viewId: "view-s1",
            revision: transcriptRevision,
            results: body.references.map((reference) =>
              reference === missingProbeReference
                ? {
                    reference,
                    availability: "missing",
                    message: "The referenced file was not found",
                  }
                : reference === invalidProbeReference
                  ? {
                      reference,
                      availability: "invalid",
                      message: "The reference is not a file",
                    }
                  : {
                      reference,
                      availability: "available",
                      workspacePath: stripResourceLocation(reference),
                    },
            ),
          });
        }
        if (url.startsWith("/api/html-previews/"))
          return new Response(null, { status: 204 });
        if (url.endsWith("/interactive"))
          return Response.json({
            id: "html-grant",
            url: "/html-preview/html-grant/demo.html",
          });
        if (url.startsWith("/api/resources/resolve")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            reference: string;
            workspacePath?: string;
          };
          // Match the Host's canonical workspace path, not URL spelling.
          const resolvedPath = (
            body.workspacePath ?? stripResourceLocation(body.reference)
          ).replace(/^\.\//, "");
          if (resolvedPath === "folder")
            return Response.json(
              { error: "The reference is not a file" },
              { status: 400 },
            );
          const id = fixtureFile(resolvedPath);
          const file = source[id];
          return Response.json({
            id,
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            workspacePath: resolvedPath,
            name: resolvedPath.split("/").at(-1),
            mimeType: file.mimeType,
            size: file.text.length,
            kind: file.kind,
          });
        }
        const match = /^\/api\/resources\/([^/]+)\/content(?:\?|$)/.exec(url);
        if (match) {
          const file = source[fixtureFile(match[1]!)];
          return new Response(file.text, {
            headers: { "Content-Type": file.mimeType },
          });
        }
        return Response.json({ error: `unhandled ${url}` }, { status: 404 });
      }),
    );
    // This suite shares a store; reconnect now intentionally retains navigation.
    // Start each independent case with an explicitly cleared browser workbench.
    store.showFileBrowser();
    for (const tab of store.getState().resourceTabs)
      store.closeResourceTab(tab.reference);
    store.setWorkspaceQuery("");
    for (const dir of store.getState().workspaceExpandedDirs)
      store.toggleWorkspaceDirectory(dir);
    store.setWorkspaceShowHidden(false);
    await store.init();
    store.setResourcesOpen(false);
    store.setContextMode("files");
  });

  function requests(path: string) {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).startsWith(path));
  }

  function showContext() {
    store.setResourcesOpen(true);
    return render(<ContextPane />);
  }

  it("reveals a folder and a Recent file without leaving Files, and reports a Host refusal", async () => {
    const shown: unknown[] = [];
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/resources/show-in-file-manager")
        return original(input, init);
      const body = JSON.parse(String(init?.body));
      shown.push(body);
      return body.directory
        ? Response.json({ ok: true })
        : Response.json({ error: "No desktop is available" }, { status: 503 });
    });

    showContext();
    render(<Notices onViewUpdates={() => {}} />);
    const folder = await screen.findByRole("button", { name: /^src$/ });
    fireEvent.click(folder, { ctrlKey: true });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(await screen.findByRole("button", { name: /^notes\.md/ }), {
      metaKey: true,
    });
    expect(await screen.findByText("No desktop is available")).toBeVisible();
    expect(shown).toEqual([
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

  it.each(["revision", "transport"] as const)(
    "refreshes Recent in place when its %s changes",
    async (owner) => {
      showContext();
      await screen.findByRole("button", { name: /notes\.md/ });
      await waitFor(() =>
        expect(
          store.getState().resourceStanding["notes.md"]?.availability,
        ).toBe("available"),
      );

      let releaseList!: () => void;
      resourceListGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      resourceListHead = "replacement.md";
      const listCount = requests("/api/resources/list").length;
      try {
        if (owner === "revision") {
          transcriptRevision = 2;
          act(() => {
            FakeWebSocket.instances.at(-1)?.emit({
              type: "snapshot",
              data: activeSnapshot({
                transcriptPage: {
                  revision: 2,
                  hasOlder: true,
                  olderCursor: "older-s1",
                },
              }),
            });
          });
        } else {
          await act(() => store.init());
        }
        await waitFor(() =>
          expect(requests("/api/resources/list").length).toBe(listCount + 1),
        );
        expect(screen.getByRole("button", { name: /notes\.md/ })).toBeVisible();
        expect(screen.queryByText("Loading recent files…")).toBeNull();
        if (owner === "revision") {
          expect(
            store.getState().resourceStanding["notes.md"]?.workspacePath,
          ).toBe("notes.md");
        }
      } finally {
        act(releaseList);
      }
      expect(
        await screen.findByRole("button", { name: /replacement\.md/ }),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: /notes\.md/ })).toBeNull();
    },
  );

  it("reuses the named file tab for line targets and retains Browse and Source positions", async () => {
    resourceListHead = "notes.md#L3";
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computedStyle(element);
      if (element.classList.contains("source-view")) style.lineHeight = "20px";
      return style;
    });
    showContext();
    await screen.findByRole("button", { name: /^notes\.md/ });
    const scroll = () =>
      document.querySelector<HTMLElement>(".files-browser__scroll")!;
    scroll().scrollTop = 137;
    await act(() => store.openResource("notes.md"));
    expect(
      await screen.findByRole("heading", { name: "Previewed notes" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(scroll().scrollTop).toBe(137);
    await waitFor(() =>
      expect(
        store.getState().resourceStanding["notes.md#L3"]?.workspacePath,
      ).toBe("notes.md"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^notes\.md/ }));
    const source = await screen.findByRole("region", { name: "File source" });
    expect(source.scrollTop).toBe(40);
    expect(
      screen.getByRole("tab", { name: "notes.md", selected: true }),
    ).toBeVisible();

    await act(() => store.openResource("notes.md#L4", "notes.md"));
    const retargeted = screen.getByRole("region", { name: "File source" });
    expect(retargeted.scrollTop).toBe(60);
    fireEvent.scroll(retargeted, { target: { scrollTop: 27 } });
    const listsBeforeAppend = requests("/api/resources/list").length;
    transcriptRevision = 2;
    act(() => {
      FakeWebSocket.instances.at(-1)?.emit({
        type: "snapshot",
        data: activeSnapshot({
          transcriptPage: { revision: 2, appendFromRevision: 2 },
        }),
      });
    });
    await waitFor(() => expect(store.getState().transcriptRevision).toBe(2));
    const retainedSource = await screen.findByRole("region", {
      name: "File source",
    });
    expect(retainedSource.scrollTop).toBe(27);
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
    const calls = vi.mocked(fetch).mock.calls;
    try {
      fireEvent.click(refresh);
      expect(refresh).toBeDisabled();
      fireEvent.click(screen.getByRole("tab", { name: "Files" }));
      await screen.findByRole("button", { name: "README.md" });
      await waitFor(() =>
        expect(requests("/api/resources/probe").length).toBeGreaterThan(0),
      );
      expect(refresh).toBeEnabled();

      const before = calls.length;
      const lists = requests("/api/resources/list").length;
      const probes = requests("/api/resources/probe").length;
      resourceListGate = recent.promise;
      fireEvent.click(refresh);
      expect(refresh).toHaveAttribute("aria-busy", "true");
      await act(async () => git.resolve());
      expect(refresh).toBeDisabled();
      expect(requests("/api/resources/list").length).toBeGreaterThan(lists);
      const refreshUrls = calls.slice(before).map(([input]) => String(input));
      expect(refreshUrls).toContainEqual(
        expect.stringMatching(/^\/api\/files\/list\?.*refresh=1/),
      );
      expect(refreshUrls).not.toContainEqual(
        expect.stringMatching(/^\/api\/git\/status/),
      );

      await act(async () => recent.resolve());
      await waitFor(() =>
        expect(requests("/api/resources/probe").length).toBeGreaterThan(probes),
      );
      expect(refresh).toBeEnabled();
    } finally {
      await act(async () => {
        git.resolve();
        recent.resolve();
      });
    }
  });

  it("marks missing Recent files, omits non-files, and offers no Retry for a direct non-file", async () => {
    missingProbeReference = "demo.html";
    invalidProbeReference = "old-1.md";
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

  it("revokes active HTML interaction after a projection replacement", async () => {
    showContext();
    await act(() => store.openResource("demo.html"));
    fireEvent.click(screen.getByRole("button", { name: "Enable interaction" }));
    await waitFor(() =>
      expect(screen.getByTitle("Preview demo.html")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      ),
    );
    act(() => {
      FakeWebSocket.instances.at(-1)?.emit({
        type: "snapshot",
        data: activeSnapshot({
          transcriptPage: {
            revision: 2,
            appendFromRevision: 2,
            incarnation: "projection-2",
          },
        }),
      });
    });
    await waitFor(() =>
      expect(requests("/api/html-previews/html-grant")).toHaveLength(1),
    );
    expect(await screen.findByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    expect(
      screen.getByRole("button", { name: "Enable interaction" }),
    ).toBeVisible();
  });
});
