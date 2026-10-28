// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitDiffSide,
  GitPathIdentity,
  ResourceProbeResult,
} from "../../shared/contracts";
import type { SessionResourceReference } from "../../shared/resource-references";
import { stripResourceLocation } from "../../shared/resource-references";
import { App } from "../../src/App";
import { ContextPane } from "../../src/components/ContextPane";
import { MAX_MEDIA_PREVIEW_BYTES } from "../../src/resource-preview";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
} from "./helpers";

describe("Files pane", () => {
  let testToken = 0;
  let gitStatusFails = false;
  let gitStatusGate: Promise<void> | null = null;
  let gitStatusRequests = 0;
  let missingProbeReference: string | null = null;
  let invalidProbeReference: string | null = null;
  let resourceListRequests: Array<{ cursor?: string; limit?: number }> = [];
  let resourceProbeRequests = 0;
  let resourceResolveRequests = 0;
  let resourceResolveGate: Promise<void> | null = null;
  let resourceResolveBodies: Array<{
    reference: string;
    workspacePath?: string;
  }> = [];
  let resourceListGate: Promise<void> | null = null;
  let resourceProbeGate: Promise<void> | null = null;
  let bootstrapMessages: unknown[] = [];
  let transcriptRevision = 1;
  let resourceListHead: string | null = null;
  let htmlStartGate: Promise<void> | null = null;
  let htmlStartError = false;
  let htmlStarts = 0;
  let htmlReleases: string[] = [];

  beforeEach(async () => {
    gitStatusFails = false;
    gitStatusGate = null;
    gitStatusRequests = 0;
    missingProbeReference = null;
    invalidProbeReference = null;
    resourceListRequests = [];
    resourceProbeRequests = 0;
    resourceResolveRequests = 0;
    resourceResolveGate = null;
    resourceResolveBodies = [];
    resourceListGate = null;
    resourceProbeGate = null;
    transcriptRevision = 1;
    resourceListHead = null;
    htmlStartGate = null;
    htmlStartError = false;
    htmlStarts = 0;
    htmlReleases = [];
    bootstrapMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Open [notes](notes.md), [page](demo.html), or [Pi](https://pi.dev).",
          },
        ],
        timestamp: 1,
      },
    ];
    installFakeWebSocket();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
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
                  messages: bootstrapMessages,
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
                ? [
                    { name: "main.ts", type: "file" },
                    { name: "long.ts", type: "file" },
                  ]
                : [
                    { name: "src", type: "dir" },
                    { name: "README.md", type: "file" },
                  ],
          });
        }
        if (url.startsWith("/api/files?"))
          return Response.json({
            files: [{ name: "main.ts", path: "src/main.ts" }],
          });
        const gitPath = (
          id: string,
          display: string,
          workspacePath?: string,
        ) => ({
          id,
          display,
          utf8Path: display,
          ...(workspacePath ? { workspacePath } : {}),
        });
        if (url.startsWith("/api/git/status")) {
          gitStatusRequests += 1;
          const gate = gitStatusGate;
          gitStatusGate = null;
          if (gate) await gate;
          if (gitStatusFails)
            return Response.json({ error: "Git timed out" }, { status: 503 });
          return Response.json({
            kind: "repository",
            head: {
              kind: "branch",
              name: "feature/git",
              oid: "0123456789abcdef",
            },
            files: [
              {
                path: gitPath("notes", "notes.md", "notes.md"),
                worktree: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("both", "both.ts", "both.ts"),
                worktree: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("rename", "renamed.ts", "renamed.ts"),
                worktree: {
                  kind: "renamed",
                  originalPath: gitPath("old", "old.ts", "old.ts"),
                },
                untracked: false,
              },
              {
                path: gitPath("copy", "copied.ts", "copied.ts"),
                worktree: {
                  kind: "copied",
                  originalPath: gitPath("source", "source.ts", "source.ts"),
                },
                untracked: false,
              },
              {
                path: gitPath("conflict", "conflict.ts", "conflict.ts"),
                worktree: { kind: "unmerged" },
                conflict: { code: "UU" },
                untracked: false,
              },
              {
                path: gitPath("binary", "image.bin", "image.bin"),
                worktree: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("module", "vendor/module", "vendor/module"),
                worktree: { kind: "modified" },
                untracked: false,
                submodule: {
                  commitChanged: true,
                  trackedModified: false,
                  untracked: false,
                },
              },
              {
                path: gitPath("deleted", "gone.ts", "gone.ts"),
                worktree: { kind: "deleted" },
                untracked: false,
              },
              {
                path: gitPath("outside", "outside.ts"),
                worktree: { kind: "modified" },
                untracked: false,
              },
              {
                path: { id: "bytes", display: "bad\\xff" },
                worktree: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("new", "new.ts", "new.ts"),
                worktree: { kind: "added" },
                untracked: true,
              },
            ],
            total: 1_005,
            truncated: true,
            groups: {
              conflicted: ["conflict"],
              staged: ["both", "rename", "copy", "module"],
              unstaged: [
                "notes",
                "both",
                "binary",
                "deleted",
                "outside",
                "bytes",
              ],
              untracked: ["new"],
            },
          });
        }
        if (url.startsWith("/api/git/diff")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            pathId: string;
            side: GitDiffSide;
          };
          const paths: Record<string, GitPathIdentity> = {
            notes: gitPath("notes", "notes.md", "notes.md"),
            both: gitPath("both", "both.ts", "both.ts"),
            rename: gitPath("rename", "renamed.ts", "renamed.ts"),
            copy: gitPath("copy", "copied.ts", "copied.ts"),
            conflict: gitPath("conflict", "conflict.ts", "conflict.ts"),
            binary: gitPath("binary", "image.bin", "image.bin"),
            module: gitPath("module", "vendor/module", "vendor/module"),
            deleted: gitPath("deleted", "gone.ts", "gone.ts"),
            outside: gitPath("outside", "outside.ts"),
            bytes: { id: "bytes", display: "bad\\xff" },
            new: gitPath("new", "new.ts", "new.ts"),
          };
          const base = { path: paths[body.pathId], side: body.side };
          if (body.pathId === "binary")
            return Response.json({ ...base, kind: "binary" });
          if (body.pathId === "module")
            return Response.json({
              ...base,
              kind: "submodule",
              state: {
                commitChanged: true,
                trackedModified: false,
                untracked: false,
              },
            });
          if (body.pathId === "conflict")
            return Response.json({ ...base, kind: "conflict", code: "UU" });
          if (body.pathId === "bytes")
            return Response.json({
              ...base,
              kind: "unsupported",
              reason: "path-encoding",
            });
          if (body.pathId === "new")
            return Response.json({
              ...base,
              kind: "text",
              additions: 1,
              deletions: 0,
              truncated: false,
              encodingLossy: false,
              lines: [
                { kind: "add", text: "+new file", oldLine: null, newLine: 1 },
              ],
            });
          return Response.json({
            ...base,
            kind: "text",
            additions: 2,
            deletions: 1,
            truncated: body.pathId === "both",
            encodingLossy: false,
            lines: [
              {
                kind: "hunk",
                text: "@@ -1 +1 @@",
                oldLine: null,
                newLine: null,
              },
              { kind: "delete", text: "-old", oldLine: 1, newLine: null },
              { kind: "add", text: "+new", oldLine: null, newLine: 1 },
              {
                kind: "hunk",
                text: "@@ -10,0 +11 @@",
                oldLine: null,
                newLine: null,
              },
              { kind: "add", text: "+later", oldLine: null, newLine: 11 },
            ],
          });
        }
        if (url.startsWith("/api/resources/list")) {
          const responseRevision = transcriptRevision;
          const gate = resourceListGate;
          resourceListGate = null;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            cursor?: string;
            limit?: number;
          };
          resourceListRequests.push({
            ...(body.cursor ? { cursor: body.cursor } : {}),
            ...(body.limit ? { limit: body.limit } : {}),
          });
          if (gate) await gate;
          const resources = [
            resourceListHead ??
              (responseRevision === 1 ? "notes.md" : "fresh.md"),
            "demo.html",
            ...Array.from({ length: 148 }, (_, index) => `old-${index + 1}.md`),
          ].map((reference) => ({
            key: `file:${reference}`,
            reference,
            label: reference,
            source: "link" as const,
          }));
          const offset = body.cursor
            ? Number(body.cursor.slice("cursor:".length))
            : 0;
          const limit = body.limit ?? 8;
          const end = Math.min(resources.length, offset + limit);
          return Response.json({
            sessionId: "s1",
            viewId: "view-s1",
            revision: responseRevision,
            offset,
            total: resources.length,
            nextCursor: end < resources.length ? `cursor:${end}` : null,
            resources: resources.slice(offset, end),
          });
        }
        if (url.startsWith("/api/resources/probe")) {
          resourceProbeRequests += 1;
          const gate = resourceProbeGate;
          resourceProbeGate = null;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            references: string[];
          };
          if (gate) await gate;
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
                      workspacePath: reference,
                    },
            ),
          });
        }
        if (url.startsWith("/api/html-previews/")) {
          htmlReleases.push(url);
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/interactive")) {
          const id = `html-grant-${++htmlStarts}`;
          if (htmlStartGate) await htmlStartGate;
          if (htmlStartError)
            return Response.json({ error: "Start refused" }, { status: 409 });
          return Response.json({ id, url: `/html-preview/${id}/demo.html` });
        }
        if (url.startsWith("/api/resources/resolve")) {
          resourceResolveRequests += 1;
          const gate = resourceResolveGate;
          resourceResolveGate = null;
          if (gate) await gate;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            reference: string;
            workspacePath?: string;
          };
          resourceResolveBodies.push(body);
          // Match the Host's canonical workspace path, not URL spelling.
          const resolvedPath = (
            body.workspacePath ?? stripResourceLocation(body.reference)
          ).replace(/^\.\//, "");
          if (resolvedPath === "folder")
            return Response.json(
              { error: "The reference is not a file" },
              { status: 400 },
            );
          if (resolvedPath.endsWith(".pdf"))
            return Response.json({
              id: "pdf",
              sessionId: "s1",
              viewId: "view-s1",
              reference: body.reference,
              workspacePath: resolvedPath,
              name: resolvedPath.split("/").at(-1) ?? resolvedPath,
              mimeType: "application/pdf",
              size: 64,
              kind: "pdf",
            });
          const html = resolvedPath.endsWith(".html");
          const truncatedHtml = resolvedPath.endsWith("truncated.html");
          const truncatedMarkdown = resolvedPath.endsWith("truncated.md");
          const notebook = resolvedPath.endsWith(".ipynb");
          const svg = resolvedPath.endsWith(".svg");
          const largeSvg = resolvedPath.endsWith("large.svg");
          const text = resolvedPath.endsWith(".ts");
          const id = truncatedHtml
            ? "truncated-html"
            : html
              ? "html"
              : truncatedMarkdown
                ? "truncated-markdown"
                : notebook
                  ? "notebook"
                  : largeSvg
                    ? "large-svg"
                    : svg
                      ? "svg"
                      : text
                        ? "text"
                        : "markdown";
          return Response.json({
            id,
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            workspacePath: resolvedPath,
            name: resolvedPath.split("/").at(-1) ?? resolvedPath,
            mimeType: html
              ? "text/html"
              : notebook
                ? "application/x-ipynb+json"
                : svg
                  ? "image/svg+xml"
                  : text
                    ? "text/typescript"
                    : "text/markdown",
            size: largeSvg ? MAX_MEDIA_PREVIEW_BYTES + 1 : text ? 2_048 : 64,
            kind: html
              ? "html"
              : notebook
                ? "notebook"
                : svg
                  ? "image"
                  : text
                    ? "text"
                    : "markdown",
          });
        }
        if (url.includes("/api/resources/truncated-markdown/content"))
          return new Response("# Previewed notes", {
            status: 206,
            headers: { "Content-Range": "bytes 0-16/4096" },
          });
        if (url.includes("/api/resources/truncated-html/content"))
          return new Response("<h1>Partial page</h1>", {
            status: 206,
            headers: { "Content-Range": "bytes 0-20/4096" },
          });
        if (url.includes("/api/resources/markdown/content"))
          return new Response("# Previewed notes\n\n[Open main](src/main.ts)");
        if (url.includes("/api/resources/notebook/content"))
          return new Response(
            JSON.stringify({
              cells: [
                { cell_type: "markdown", source: ["# Notebook title"] },
                {
                  cell_type: "code",
                  execution_count: 3,
                  source: ["print('hello')"],
                  outputs: [{ output_type: "stream", text: ["hello\n"] }],
                },
              ],
              metadata: { language_info: { name: "python" } },
              nbformat: 4,
              nbformat_minor: 5,
            }),
            { headers: { "Content-Type": "application/x-ipynb+json" } },
          );
        if (url.includes("/api/resources/large-svg/content")) {
          const source = '<svg xmlns="http://www.w3.org/2000/svg">';
          return new Response(source, {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-${source.length - 1}/${MAX_MEDIA_PREVIEW_BYTES + 1}`,
              "Content-Type": "image/svg+xml",
            },
          });
        }
        if (url.includes("/api/resources/pdf/content"))
          return new Response("%PDF-1.7", {
            headers: { "Content-Type": "application/pdf" },
          });
        if (url.includes("/api/resources/svg/content"))
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>',
            { headers: { "Content-Type": "image/svg+xml" } },
          );
        if (url.includes("/api/resources/text/content"))
          return new Response(
            Array.from(
              { length: 120 },
              (_, index) => `export const line${index + 1} = ${index + 1};`,
            ).join("\n"),
          );
        if (url.includes("/api/resources/html/content")) {
          return new Response(
            '<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script><h1>Safe page</h1></body></html>',
          );
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
    await store.init(`token-${++testToken}`);
    store.setResourcesOpen(false);
    store.setContextMode("files");
  });

  it("keeps Recent usable through transient list and probe failures without a retry chore", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let failProbe = true;
    let failList = false;
    let lists = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/resources/list")) {
        lists += 1;
        if (failList)
          return Response.json(
            { error: "Temporary list failure" },
            { status: 503 },
          );
      }
      if (url.startsWith("/api/resources/probe") && failProbe)
        return Response.json(
          { error: "Temporary probe failure" },
          { status: 503 },
        );
      return original(input, init);
    });
    vi.useFakeTimers();
    try {
      store.setResourcesOpen(true);
      const { container, unmount } = render(<ContextPane />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const row = container.querySelector(".recent-file")!;
      expect(row).toBeVisible();
      expect(row).not.toHaveClass("recent-file--unavailable");
      expect(row.getAttribute("aria-label")).not.toContain("File unavailable");
      failProbe = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(container.querySelector(".recent-file")).toBe(row);
      failList = true;
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh context pane" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByText("Retry recent files")).toBeNull();
      expect(container.querySelector(".recent-file")).toBe(row);
      const beforeRecovery = lists;
      failList = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(lists).toBe(beforeRecovery + 1);
      expect(container.querySelector(".recent-file")).toBe(row);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens grouped changes in ordinary file tabs with net comparison and hunk navigation", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    store.setResourcesOpen(true);
    store.setContextMode("changes");
    await store.refreshGitInspection();
    const { container: pane } = render(
      <ContextPane isModal={false} onClose={vi.fn()} />,
    );
    expect(
      await screen.findByRole("heading", { name: /Conflicts/ }),
    ).toBeInTheDocument();
    expect(pane.querySelector(".res__index-header")).toHaveTextContent(
      "feature/git1005 changes",
    );
    expect(
      screen.getByRole("heading", { name: /Changes/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Staged|Unstaged/ }),
    ).toBeNull();
    expect(screen.queryByLabelText("Source changes for notes.md")).toBeNull();
    expect(pane.querySelector(".file-detail-header")).toBeNull();
    expect(
      screen.getByText("Showing first 11 of 1005 changed paths."),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Untracked — not yet added to Git"),
    ).toHaveClass("git-deco--untracked");
    expect(
      screen.getByRole("button", {
        name: "renamed.ts, renamed, renamed from old.ts",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "copied.ts, copied, copied from source.ts",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "notes.md, modified" }));
    expect(
      await screen.findByLabelText("Source changes for notes.md"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "notes.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(
      screen.getByRole("button", { name: "notes.md, modified" }),
    ).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "both.ts, modified" }));
    const source = await screen.findByLabelText("Source changes for both.ts");
    expect(source).toHaveAttribute("data-pane-scroll-active", "true");
    expect(within(pane).getByTitle("Line changes")).toHaveTextContent("+2−1");
    expect(screen.getByText("Source truncated")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next change" });
    expect(source.querySelector('[data-change-index="0"]')).toHaveClass(
      "source-diff__line--active",
    );
    fireEvent.click(next);
    expect(source.querySelector('[data-change-index="1"]')).toHaveClass(
      "source-diff__line--active",
    );

    expect(
      screen.queryByRole("combobox", { name: "Comparison side" }),
    ).toBeNull();
    expect(store.getState().selectedGitSide).toBe("worktree");
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(
      screen.getAllByRole("button", { name: "both.ts, modified" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "both.ts, modified" }),
    ).toHaveAttribute("aria-current", "true");

    for (const [name, title] of [
      [/image\.bin/, "Binary change"],
      [/conflict\.ts/, "Unresolved conflict"],
      [/vendor\/module/, "Submodule change"],
      [/bad\\xff/, "Source unavailable"],
    ] as const) {
      fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
      fireEvent.click(screen.getByRole("button", { name }));
      expect(await screen.findByText(title)).toBeInTheDocument();
      if (title === "Source unavailable")
        expect(
          screen.getByText(/cannot be represented as UTF-8/),
        ).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: /new\.ts/ }));
    const added = await screen.findByRole("region", {
      name: "Source changes for new.ts",
    });
    expect(added).toHaveTextContent("new file");
    expect(added.querySelectorAll(".source-diff__line--add")).toHaveLength(1);
    expect(added.querySelector(".source-diff__line--delete")).toBeNull();
    // The same new-file tab can still return to its ordinary body.
    fireEvent.click(screen.getByRole("button", { name: "Git changes" }));
    expect(
      await screen.findByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
  });

  it("keeps native Recent labels readable without changing their encoded open target", async () => {
    const literal = "/outside/Review C#/report%20draft.md";
    const reference = "/outside/Review%20C%23/report%2520draft.md";
    resourceListHead = reference;
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      const url = String(input);
      if (url.startsWith("/api/resources/list")) {
        const body = (await response.json()) as {
          resources: SessionResourceReference[];
        };
        for (const entry of body.resources) {
          if (entry.reference !== reference) continue;
          entry.label = literal;
          entry.source = "tool";
        }
        return Response.json(body);
      }
      if (url.startsWith("/api/resources/probe")) {
        const body = (await response.json()) as {
          results: ResourceProbeResult[];
        };
        for (const entry of body.results)
          if (entry.reference === reference) delete entry.workspacePath;
        return Response.json(body);
      }
      return response;
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const row = await screen.findByRole("button", {
      name: literal,
    });
    expect(row).toHaveAttribute(
      "title",
      `${literal}\nCtrl+click: Show in file manager`,
    );
    expect(row).toHaveTextContent("report%20draft.md");
    expect(screen.queryByRole("button", { name: reference })).toBeNull();
    fireEvent.click(row);
    await waitFor(() =>
      expect(resourceResolveBodies).toContainEqual({
        sessionId: "s1",
        reference,
      }),
    );
  });

  it("shows Ctrl-clicked files and folders without changing the browser selection", async () => {
    const shown: unknown[] = [];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/resources/show-in-file-manager") {
        shown.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      return originalFetch(input, init);
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    const folder = await within(pane).findByRole("button", { name: /^src$/ });
    fireEvent.click(folder, { ctrlKey: true });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      await within(pane).findByRole("button", { name: /^README\.md$/ }),
      { ctrlKey: true },
    );
    fireEvent.click(
      await within(pane).findByRole("button", { name: /^notes\.md/ }),
      { metaKey: true },
    );
    await waitFor(() =>
      expect(shown).toEqual([
        {
          sessionId: "s1",
          reference: "src",
          workspacePath: "src",
          directory: true,
        },
        {
          sessionId: "s1",
          reference: "README.md",
          workspacePath: "README.md",
          directory: false,
        },
        {
          sessionId: "s1",
          reference: "notes.md",
          workspacePath: "notes.md",
          directory: false,
        },
      ]),
    );
    expect(resourceResolveRequests).toBe(0);
    expect(store.getState().fileBrowserView).toBe("browse");
    fireEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "true");
  });

  it("surfaces an unavailable file manager without opening or dropping file tabs", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/resources/show-in-file-manager"
        ? Response.json(
            { error: "No desktop is available to show this item" },
            { status: 503 },
          )
        : originalFetch(input, init),
    );
    render(<App />);
    await act(() => store.showInFileManager("notes.md", "notes.md"));
    expect(
      await screen.findByText("No desktop is available to show this item"),
    ).toBeVisible();
    expect(resourceResolveRequests).toBe(0);
  });

  it("browses, searches, and keeps only the essential file actions", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );

    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("button", { name: "README.md" }),
    ).toBeInTheDocument();
    expect(
      within(pane).getByRole("heading", { name: "proj" }),
    ).toBeInTheDocument();
    // Recent-reference observations settle independently of the directory listing.
    await waitFor(() =>
      expect(
        within(pane)
          .getByRole("button", { name: "demo.html" })
          .querySelector("svg"),
      ).toHaveClass("lucide-file-code-corner"),
    );
    const directory = await within(pane).findByRole("button", { name: "src" });
    expect(directory.querySelector(".lucide-folder")).not.toBeNull();
    fireEvent.click(directory);
    const fileIcon = (
      await within(pane).findByRole("button", { name: "long.ts" })
    ).querySelector("svg");
    expect(fileIcon).toHaveClass("lucide-file-code-corner");
    expect(fileIcon).toHaveAttribute("width", "13");
    expect(fileIcon).toHaveAttribute("aria-hidden", "true");
    const browserScroller = pane.querySelector<HTMLElement>(
      ".files-browser__scroll",
    )!;
    browserScroller.scrollTop = 137;
    fireEvent.click(
      await within(pane).findByRole("button", { name: "long.ts" }),
    );
    expect(pane.querySelector(".files-browser")).toBeNull();
    expect(within(pane).getByRole("tab", { name: "long.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(pane.querySelector(".res__index")).toBeNull();

    expect(
      await within(pane).findByRole("region", { name: "File source" }),
    ).toHaveAttribute("data-pane-scroll-active", "true");
    expect(within(pane).queryByRole("button", { name: "Preview" })).toBeNull();
    expect(
      within(pane).getByRole("button", { name: "Download long.ts" }),
    ).toBeEnabled();
    expect(
      within(pane).queryByRole("button", { name: "Add to prompt" }),
    ).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Copy all" })).toBeNull();
    expect(
      within(pane).queryByRole("spinbutton", { name: "Go to line" }),
    ).toBeNull();
    fireEvent.click(
      within(pane).getByRole("button", { name: "Copy path src/long.ts" }),
    );
    expect(writeText).toHaveBeenCalledWith("src/long.ts");

    fireEvent.click(within(pane).getByRole("tab", { name: "Files" }));
    const restoredScroller = pane.querySelector<HTMLElement>(
      ".files-browser__scroll",
    )!;
    expect(restoredScroller).not.toBe(browserScroller);
    expect(restoredScroller.scrollTop).toBe(137);
    expect(pane.querySelectorAll(".recent-files .recent-file")).toHaveLength(5);

    const search = within(pane).getByRole("searchbox", {
      name: "Search workspace files",
    });
    fireEvent.change(search, { target: { value: "main" } });
    const match = await within(pane).findByRole("button", {
      name: /main\.ts.*src\/main\.ts/,
    });
    expect(match).toBeInTheDocument();
    expect(match.querySelector("svg")).toHaveClass("lucide-file-code-corner");
    expect(match.querySelector(".workspace-tree__path")).toHaveAttribute(
      "title",
      "src/main.ts",
    );
    expect(match.querySelector(".resource-path__visible")).toHaveTextContent(
      /^src$/,
    );
    expect(match).toHaveAttribute(
      "title",
      "src/main.ts\nCtrl+click: Show in file manager",
    );
    expect(match.querySelector(".search-match")).toHaveTextContent(/^main$/);
    fireEvent.click(match);
    expect(
      await within(pane).findByRole("button", {
        name: "Copy path src/main.ts",
      }),
    ).toBeInTheDocument();
  });

  it("keeps independent file positions through tab and tool switches, and closes only the chosen tab", async () => {
    render(<App />);
    await act(async () => {
      await store.openWorkspaceFile("src/long.ts");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    const first = await within(pane).findByRole("region", {
      name: "File source",
    });
    fireEvent.scroll(first, { target: { scrollTop: 137, scrollLeft: 48 } });
    await act(async () => {
      await store.openWorkspaceFile("src/main.ts");
    });
    const second = await within(pane).findByRole("region", {
      name: "File source",
    });
    expect(second.scrollTop).toBe(0);
    fireEvent.scroll(second, { target: { scrollTop: 52, scrollLeft: 12 } });
    fireEvent.click(within(pane).getByRole("tab", { name: "Files" }));
    expect(
      within(pane).getByRole("searchbox", { name: "Search workspace files" }),
    ).toBeVisible();
    fireEvent.click(within(pane).getByRole("tab", { name: "long.ts" }));
    await waitFor(() =>
      expect(
        within(pane).getByRole("region", { name: "File source" }).scrollTop,
      ).toBe(137),
    );
    expect(
      within(pane).getByRole("region", { name: "File source" }).scrollLeft,
    ).toBe(48);
    fireEvent.click(within(pane).getByRole("tab", { name: "Changes" }));
    fireEvent.click(within(pane).getByRole("tab", { name: "main.ts" }));
    await waitFor(() =>
      expect(
        within(pane).getByRole("region", { name: "File source" }).scrollTop,
      ).toBe(52),
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Close long.ts" }),
    );
    expect(within(pane).queryByRole("tab", { name: "long.ts" })).toBeNull();
    expect(within(pane).getByRole("tab", { name: "main.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Close main.ts" }),
    );
    expect(within(pane).getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps a changed-file selection when returning to Browse", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByRole("heading", { name: "Previewed notes" });
    await waitFor(() =>
      expect(store.getState().selectedGitPathId).toBe("notes"),
    );

    fireEvent.click(within(pane).getByRole("tab", { name: "Files" }));
    expect(store.getState().selectedGitPathId).toBe("notes");
    fireEvent.click(within(pane).getByRole("tab", { name: "Changes" }));
    expect(
      await within(pane).findByRole("button", {
        name: "notes.md, modified",
      }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("refreshes Recent in place when the visible transcript revision changes", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByRole("button", { name: /notes\.md/ });
    await waitFor(() =>
      expect(store.getState().resourceWorkspacePaths["notes.md"]).toBe(
        "notes.md",
      ),
    );

    let releaseList: (() => void) | undefined;
    resourceListGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let releaseProbe: (() => void) | undefined;
    resourceProbeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probesBefore = resourceProbeRequests;
    transcriptRevision = 2;
    act(() => {
      FakeWebSocket.instances.at(-1)?.emit({
        type: "snapshot",
        data: activeSnapshot({
          transcriptPage: {
            revision: 2,
            messages: bootstrapMessages,
            hasOlder: true,
            olderCursor: "older-s1",
          },
        }),
      });
    });

    await waitFor(() => expect(resourceListRequests).toHaveLength(2));
    await waitFor(() => expect(resourceProbeRequests).toBe(probesBefore + 1));
    expect(
      within(pane).getByRole("button", { name: /notes\.md/ }),
    ).toBeVisible();
    expect(store.getState().resourceWorkspacePaths["notes.md"]).toBe(
      "notes.md",
    );
    expect(within(pane).queryByText("Loading recent files…")).toBeNull();
    expect(
      within(pane).queryByRole("button", { name: /fresh\.md/ }),
    ).toBeNull();

    act(() => {
      releaseProbe?.();
      releaseList?.();
    });
    expect(
      await within(pane).findByRole("button", { name: /fresh\.md/ }),
    ).toBeVisible();
    expect(
      within(pane).queryByRole("button", { name: /notes\.md/ }),
    ).toBeNull();
  });

  it("revalidates Recent across a same-projection transport replacement", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByRole("button", { name: /notes\.md/ });

    let releaseList: (() => void) | undefined;
    resourceListGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    resourceListHead = "replacement.md";
    const requestsBefore = resourceListRequests.length;
    await act(async () => {
      await store.init(`replacement-${++testToken}`);
    });

    await waitFor(() =>
      expect(resourceListRequests.length).toBe(requestsBefore + 1),
    );
    expect(
      within(pane).getByRole("button", { name: /notes\.md/ }),
    ).toBeVisible();

    act(() => releaseList?.());
    expect(
      await within(pane).findByRole("button", { name: /replacement\.md/ }),
    ).toBeVisible();
    expect(
      within(pane).queryByRole("button", { name: /notes\.md/ }),
    ).toBeNull();
  });

  it.each(["notes.md#L12", "notes.md:12"])(
    "opens explicit document line references in Source: %s",
    async (reference) => {
      render(<App />);
      await act(async () => {
        await store.openResource(reference);
      });
      const pane = await screen.findByRole("complementary", {
        name: "Context panel",
      });
      expect(
        await within(pane).findByRole("region", { name: "File source" }),
      ).toHaveTextContent("# Previewed notes");
      act(() => {
        FakeWebSocket.instances.at(-1)?.emit({
          type: "snapshot",
          data: activeSnapshot({
            transcriptPage: { revision: 2, appendFromRevision: 2 },
          }),
        });
      });
      expect(
        await within(pane).findByRole("region", { name: "File source" }),
      ).toHaveTextContent("# Previewed notes");
      fireEvent.click(within(pane).getByRole("button", { name: "Preview" }));
      expect(
        await within(pane).findByRole("heading", { name: "Previewed notes" }),
      ).toBeVisible();
    },
  );

  it("keeps a scrolled code preview without loading hidden Recent rows", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("src/long.ts");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    const source = await within(pane).findByRole("region", {
      name: "File source",
    });
    source.scrollTop = 137;
    const listRequestsBefore = resourceListRequests.length;
    const resolvesBefore = resourceResolveRequests;

    transcriptRevision = 2;
    act(() => {
      FakeWebSocket.instances.at(-1)?.emit({
        type: "snapshot",
        data: activeSnapshot({
          transcriptPage: {
            revision: 2,
            messages: bootstrapMessages,
          },
        }),
      });
    });

    await waitFor(() => expect(store.getState().transcriptRevision).toBe(2));
    expect(resourceResolveRequests).toBe(resolvesBefore);
    expect(resourceListRequests).toHaveLength(listRequestsBefore);
    expect(within(pane).getByRole("region", { name: "File source" })).toBe(
      source,
    );
    expect(source.scrollTop).toBe(137);
    expect(within(pane).queryByText("Loading preview")).toBeNull();
  });

  it("does not let an older probe overwrite a successful resolve", async () => {
    missingProbeReference = "notes.md";
    let releaseProbe: (() => void) | undefined;
    resourceProbeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    await waitFor(() => expect(resourceProbeRequests).toBe(1));

    await act(async () => {
      await store.openResource("notes.md");
    });
    expect(store.getState().resourceWorkspacePaths["notes.md"]).toBe(
      "notes.md",
    );

    act(() => releaseProbe?.());
    await waitFor(() =>
      expect(store.getState().resourceWorkspacePaths["demo.html"]).toBe(
        "demo.html",
      ),
    );
    expect(store.getState().resourceAvailability["notes.md"]).toBeUndefined();
    expect(store.getState().resourceWorkspacePaths["notes.md"]).toBe(
      "notes.md",
    );
  });

  it("refreshes the Files sources without coupling them to Git status", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByRole("button", { name: "README.md" });

    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const probesBefore = resourceProbeRequests;
    fireEvent.click(
      within(pane).getByRole("button", { name: "Refresh context pane" }),
    );
    await waitFor(() =>
      expect(
        (fetch as ReturnType<typeof vi.fn>).mock.calls
          .slice(callsBefore)
          .map(([input]) => String(input))
          .some(
            (url) =>
              url.startsWith("/api/files/list") && url.includes("refresh=1"),
          ),
      ).toBe(true),
    );
    expect(resourceListRequests.length).toBeGreaterThan(1);
    await waitFor(() =>
      expect(resourceProbeRequests).toBeGreaterThan(probesBefore),
    );
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls
        .slice(callsBefore)
        .map(([input]) => String(input))
        .some((url) => url.startsWith("/api/git/status")),
    ).toBe(false);
  });

  it.each(["changes", "file"] as const)(
    "keeps the refresh action idle during background Git observation in the %s view",
    async (view) => {
      store.setResourcesOpen(true);
      store.setContextMode("changes");
      await store.refreshGitInspection();
      if (view === "file") await store.openGitDiff("notes", "worktree");
      render(<ContextPane />);
      await waitFor(() =>
        expect(store.getState().gitStatusRefreshing).toBe(false),
      );
      const refresh = screen.getByRole("button", {
        name: "Refresh context pane",
      });
      const icon = refresh.querySelector(".lucide-refresh-cw");
      expect(icon).not.toBeNull();
      let release!: () => void;
      gitStatusGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending!: Promise<void>;
      act(() => {
        pending = store.refreshGitInspection();
      });
      try {
        await waitFor(() =>
          expect(store.getState().gitStatusRefreshing).toBe(true),
        );
        expect(refresh).toBeEnabled();
        expect(refresh).toHaveAttribute("aria-busy", "false");
        expect(refresh.querySelector(".lucide-refresh-cw")).toBe(icon);
        expect(refresh.querySelector(".pi-loading")).toBeNull();
      } finally {
        await act(async () => {
          release();
          await pending;
        });
      }
      expect(refresh).toBeEnabled();
      expect(refresh).toHaveAttribute("aria-busy", "false");
      expect(refresh.querySelector(".lucide-refresh-cw")).toBe(icon);
    },
  );

  it("marks only an explicit refresh busy and prevents duplicate requests until it settles", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("changes");
    await store.refreshGitInspection();
    render(<ContextPane />);
    await waitFor(() =>
      expect(store.getState().gitStatusRefreshing).toBe(false),
    );
    const refresh = screen.getByRole("button", {
      name: "Refresh context pane",
    });
    let release!: () => void;
    gitStatusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = gitStatusRequests;
    try {
      fireEvent.click(refresh);
      await waitFor(() => expect(gitStatusRequests).toBe(requests + 1));
      expect(refresh).toBeDisabled();
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(refresh.querySelector(".pi-loading")).not.toBeNull();
      expect(refresh.querySelector(".lucide-refresh-cw")).toBeNull();
      fireEvent.click(refresh);
      expect(gitStatusRequests).toBe(requests + 1);
    } finally {
      await act(async () => {
        release();
      });
    }
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(refresh.querySelector(".lucide-refresh-cw")).not.toBeNull();
    expect(refresh.querySelector(".pi-loading")).toBeNull();
    expect(gitStatusRequests).toBe(requests + 1);
  });

  it.each(["tool", "file"] as const)(
    "keeps the new %s refresh busy when a previous scope's request completes",
    async (scope) => {
      await store.refreshGitInspection();
      await store.openGitDiff("notes", "worktree");
      if (scope === "tool") store.setContextMode("changes");
      render(<ContextPane />);
      await waitFor(() =>
        expect(store.getState().gitStatusRefreshing).toBe(false),
      );
      const refresh = screen.getByRole("button", {
        name: "Refresh context pane",
      });
      let releaseOld!: () => void;
      let releaseNew: (() => void) | undefined;
      gitStatusGate = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      try {
        fireEvent.click(refresh);
        await waitFor(() =>
          expect(store.getState().gitStatusRefreshing).toBe(true),
        );
        expect(refresh).toHaveAttribute("aria-busy", "true");
        if (scope === "tool") {
          fireEvent.click(screen.getByRole("tab", { name: "Files" }));
          await screen.findByRole("button", { name: "README.md" });
        } else {
          await act(async () => {
            await store.openResource("demo.html");
          });
          await screen.findByTitle("Preview demo.html");
        }
        expect(refresh).toBeEnabled();
        expect(refresh).toHaveAttribute("aria-busy", "false");
        expect(refresh.querySelector(".lucide-refresh-cw")).not.toBeNull();
        const nextGate = new Promise<void>((resolve) => {
          releaseNew = resolve;
        });
        if (scope === "tool") resourceListGate = nextGate;
        else resourceResolveGate = nextGate;
        const requests =
          scope === "tool"
            ? resourceListRequests.length
            : resourceResolveRequests;
        fireEvent.click(refresh);
        await waitFor(() =>
          expect(
            scope === "tool"
              ? resourceListRequests.length
              : resourceResolveRequests,
          ).toBe(requests + 1),
        );
        expect(refresh).toBeDisabled();
        expect(refresh).toHaveAttribute("aria-busy", "true");
        await act(async () => {
          releaseOld();
        });
        await waitFor(() =>
          expect(store.getState().gitStatusRefreshing).toBe(false),
        );
        expect(refresh).toBeDisabled();
        expect(refresh).toHaveAttribute("aria-busy", "true");
        expect(refresh.querySelector(".pi-loading")).not.toBeNull();
      } finally {
        await act(async () => {
          releaseOld();
          releaseNew?.();
        });
      }
      await waitFor(() => expect(refresh).toBeEnabled());
      expect(refresh).toHaveAttribute("aria-busy", "false");
      expect(refresh.querySelector(".lucide-refresh-cw")).not.toBeNull();
    },
  );

  it("marks missing recent references before selection", async () => {
    missingProbeReference = "demo.html";
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await waitFor(() =>
      expect(store.getState().resourceAvailability["demo.html"]).toMatchObject({
        availability: "missing",
      }),
    );
    const missing = within(pane).getByRole("button", {
      name: /demo\.html.*unavailable/i,
    });
    expect(missing).toHaveClass(
      "recent-file--unavailable",
      "recent-file--missing",
    );
    expect(missing).toHaveAttribute(
      "title",
      expect.stringContaining("not found"),
    );
  });

  it("omits non-file recent references and presents direct failures without retry", async () => {
    invalidProbeReference = "old-1.md";
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await waitFor(() =>
      expect(store.getState().resourceAvailability["old-1.md"]).toMatchObject({
        availability: "invalid",
      }),
    );
    expect(
      within(pane).queryByRole("button", { name: /old-1\.md/ }),
    ).not.toBeInTheDocument();

    await store.openResource("./folder");
    expect(
      await within(pane).findByText("The reference is not a file"),
    ).toBeInTheDocument();
    expect(within(pane).getByText("Not a file")).toBeInTheDocument();
    expect(
      within(pane).queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("opens transcript and preview references and keeps HTML isolated", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("heading", { name: "Previewed notes" }),
    ).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Preview" }));
    fireEvent.click(within(pane).getByRole("link", { name: "Open main" }));
    expect(
      await within(pane).findByRole("button", {
        name: "Copy path src/main.ts",
      }),
    ).toBeInTheDocument();
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute(
      "target",
      "_blank",
    );

    fireEvent.click(screen.getByRole("link", { name: "page" }));
    const sourceMode = await within(pane).findByRole("button", {
      name: "Source",
    });
    expect(sourceMode).toBeEnabled();
    expect(
      within(pane).queryByText("Scripts and network access blocked."),
    ).not.toBeInTheDocument();
    expect(
      within(pane).getByRole("button", { name: "Download demo.html" }),
    ).toBeInTheDocument();
    const frame = await within(pane).findByTitle("Preview demo.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(URL.createObjectURL).toHaveBeenCalled();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
    expect(
      within(pane).queryByTitle("Preview demo.html"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle resources panel" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Context panel" }),
      ).not.toBeInTheDocument(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("starts HTML only on click and releases it on Source, refresh and close", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("demo.html");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(htmlStarts).toBe(0);
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await waitFor(() =>
      expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      ),
    );
    expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
      "src",
      "/html-preview/html-grant-1/demo.html",
    );
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    await waitFor(() => expect(htmlReleases).toHaveLength(1));
    fireEvent.click(within(pane).getByRole("button", { name: "Preview" }));
    expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await within(pane).findByRole("button", { name: "Stop interaction" });
    await waitFor(() =>
      expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      ),
    );
    await act(async () => {
      await store.openResource("demo.html");
    });
    await waitFor(() => expect(htmlReleases).toHaveLength(2));
    expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await waitFor(() =>
      expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle resources panel" }),
    );
    await waitFor(() => expect(htmlReleases).toHaveLength(3));
  });

  it("discards a late HTML start after cancellation or file replacement", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("demo.html");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    let release!: () => void;
    htmlStartGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Stop interaction" }),
    );
    await act(async () => {
      release();
    });
    await waitFor(() => expect(htmlReleases).toHaveLength(1));
    expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    htmlStartGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await act(async () => {
      await store.openResource("notes.md");
      release();
    });
    await waitFor(() => expect(htmlReleases).toHaveLength(2));
    expect(
      within(pane).queryByTitle("Preview demo.html"),
    ).not.toBeInTheDocument();
  });

  it("reauthorizes a selected HTML file without inheriting its execution lease", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("demo.html");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await waitFor(() =>
      expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
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
    await waitFor(() => expect(htmlReleases).toHaveLength(1));
    expect(await within(pane).findByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    expect(store.getState().fileBrowserView).toBe("preview");
    expect(htmlStarts).toBe(1);
  });

  it("keeps failed or truncated HTML static, with a retryable explicit start", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("demo.html");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    htmlStartError = true;
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    expect(await within(pane).findByText("Start refused")).toBeVisible();
    expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
      "sandbox",
      "",
    );
    htmlStartError = false;
    fireEvent.click(
      within(pane).getByRole("button", { name: "Enable interaction" }),
    );
    await waitFor(() =>
      expect(within(pane).getByTitle("Preview demo.html")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      ),
    );
    await act(async () => {
      await store.openResource("truncated.html");
    });
    expect(
      within(pane).queryByRole("button", { name: "Enable interaction" }),
    ).not.toBeInTheDocument();
  });

  it("uses the static PDF reader rather than a native frame, retaining Download", async () => {
    render(<App />);
    await act(async () => {
      await store.openResource("document.pdf");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("document", {
        name: "Preview document.pdf",
      }),
    ).toBeInTheDocument();
    expect(pane.querySelector("iframe, object, embed")).toBeNull();
    expect(
      within(pane).getByRole("button", { name: "Download document.pdf" }),
    ).toBeInTheDocument();
  });

  it("marks a truncated rendered preview and preserves the source boundary", async () => {
    render(<App />);
    await store.openResource("truncated.md");
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByText(
        "Rendered preview truncated · Source shows the preview boundary",
      ),
    ).toBeVisible();

    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(within(pane).getByText("Preview ends here")).toBeVisible();
    expect(
      within(pane).queryByText(
        "Rendered preview truncated · Source shows the preview boundary",
      ),
    ).toBeNull();

    await act(async () => {
      await store.openResource("truncated.html");
    });
    expect(
      await within(pane).findByText(
        "Rendered preview truncated · Source shows the preview boundary",
      ),
    ).toBeVisible();
    expect(within(pane).getByTitle("Preview truncated.html")).toHaveAttribute(
      "sandbox",
      "",
    );
  });

  it("previews SVG and notebook files before offering their source", async () => {
    render(<App />);
    await store.openResource("diagram.svg");
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("button", { name: "Source" }),
    ).toBeEnabled();
    expect(within(pane).getByAltText("diagram.svg")).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toHaveTextContent("<svg");

    await store.openResource("analysis.ipynb");
    expect(
      await within(pane).findByRole("document", { name: "Notebook preview" }),
    ).toBeInTheDocument();
    expect(
      within(pane).getByRole("heading", { name: "Notebook title" }),
    ).toBeInTheDocument();
    expect(
      pane.querySelector(".notebook-preview__cell--code code"),
    ).toHaveTextContent("print('hello')");
    expect(within(pane).getByText("hello")).toBeInTheDocument();
    expect(
      pane.querySelector(
        ".notebook-preview__cell--markdown .notebook-preview__prompt",
      ),
    ).toBeEmptyDOMElement();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
  });

  it("keeps bounded SVG source available when the rendered file is too large", async () => {
    render(<App />);
    await store.openResource("large.svg");
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByText("File too large to preview"),
    ).toBeVisible();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toHaveTextContent("<svg");
    expect(within(pane).getByText("Preview ends here")).toBeVisible();
  });
});
