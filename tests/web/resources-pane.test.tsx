// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPathIdentity } from "../../shared/contracts";
import { stripResourceLocation } from "../../shared/resource-references";
import { App } from "../../src/App";
import { MAX_MEDIA_PREVIEW_BYTES } from "../../src/resource-preview";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
} from "./helpers";

describe("Files pane", () => {
  let testToken = 0;
  let gitStatusFails = false;
  let missingProbeReference: string | null = null;
  let invalidProbeReference: string | null = null;
  let resourceListRequests: Array<{ cursor?: string; limit?: number }> = [];
  let resourceProbeRequests = 0;
  let bootstrapMessages: unknown[] = [];
  let transcriptRevision = 1;

  beforeEach(async () => {
    gitStatusFails = false;
    missingProbeReference = null;
    invalidProbeReference = null;
    resourceListRequests = [];
    resourceProbeRequests = 0;
    transcriptRevision = 1;
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
                pageMessages: bootstrapMessages,
                transcriptPage: {
                  sessionId: "s1",
                  revision: transcriptRevision,
                  viewId: "view-s1",
                  incarnation: "projection-1",
                  appendFromRevision: 1,
                  messages: bootstrapMessages,
                  hasOlder: true,
                  olderCursor: "older-s1",
                },
              }),
            }),
          );
        }
        if (url.startsWith("/api/sessions"))
          return Response.json({
            sessions: [],
            total: 0,
            offset: 0,
            limit: 40,
          });
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
                unstaged: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("both", "both.ts", "both.ts"),
                staged: { kind: "modified" },
                unstaged: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("rename", "renamed.ts", "renamed.ts"),
                staged: {
                  kind: "renamed",
                  originalPath: gitPath("old", "old.ts", "old.ts"),
                },
                untracked: false,
              },
              {
                path: gitPath("copy", "copied.ts", "copied.ts"),
                staged: {
                  kind: "copied",
                  originalPath: gitPath("source", "source.ts", "source.ts"),
                },
                untracked: false,
              },
              {
                path: gitPath("conflict", "conflict.ts", "conflict.ts"),
                conflict: { code: "UU" },
                untracked: false,
              },
              {
                path: gitPath("binary", "image.bin", "image.bin"),
                unstaged: { kind: "modified" },
                untracked: false,
              },
              {
                path: gitPath("module", "vendor/module", "vendor/module"),
                staged: { kind: "modified" },
                untracked: false,
                submodule: {
                  commitChanged: true,
                  trackedModified: false,
                  untracked: false,
                },
              },
              {
                path: gitPath("deleted", "gone.ts", "gone.ts"),
                unstaged: { kind: "deleted" },
                untracked: false,
              },
              {
                path: gitPath("outside", "outside.ts"),
                unstaged: { kind: "modified" },
                untracked: false,
              },
              {
                path: { id: "bytes", display: "bad\\xff" },
                unstaged: { kind: "modified" },
                untracked: false,
              },
              { path: gitPath("new", "new.ts", "new.ts"), untracked: true },
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
            side: "staged" | "unstaged";
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
              kind: "unsupported",
              reason: "untracked-content",
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
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            cursor?: string;
            limit?: number;
          };
          resourceListRequests.push({
            ...(body.cursor ? { cursor: body.cursor } : {}),
            ...(body.limit ? { limit: body.limit } : {}),
          });
          const resources = [
            "notes.md",
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
            revision: transcriptRevision,
            offset,
            total: resources.length,
            nextCursor: end < resources.length ? `cursor:${end}` : null,
            resources: resources.slice(offset, end),
          });
        }
        if (url.startsWith("/api/resources/probe")) {
          resourceProbeRequests += 1;
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
                      workspacePath: reference,
                    },
            ),
          });
        }
        if (url.startsWith("/api/resources/resolve")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            reference: string;
          };
          const resolvedPath = stripResourceLocation(body.reference);
          if (resolvedPath === "./folder")
            return Response.json(
              { error: "The reference is not a file" },
              { status: 400 },
            );
          const html = resolvedPath.endsWith(".html");
          const notebook = resolvedPath.endsWith(".ipynb");
          const svg = resolvedPath.endsWith(".svg");
          const largeSvg = resolvedPath.endsWith("large.svg");
          const text = resolvedPath.endsWith(".ts");
          const id = html
            ? "html"
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
    await store.init(`token-${++testToken}`);
    store.setResourcesOpen(false);
    store.setContextMode("files");
  });

  it("renders grouped changes over a stable source view with change navigation", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(pane.querySelector(".res__index-header")).toHaveTextContent(
      "feature/git4 staged · 7 working · 1 conflict",
    );
    expect(
      screen.getByRole("heading", { name: /Conflicts/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Staged/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Unstaged/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "notes.md, unstaged modified" }),
      ).toHaveAttribute("aria-current", "true"),
    );
    expect(
      await screen.findByLabelText("Source changes for notes.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Showing first 11 of 1005 changed paths."),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Untracked — not yet added to Git"),
    ).toHaveClass("git-deco--untracked");
    expect(
      screen.getByRole("button", {
        name: "renamed.ts, staged renamed, renamed from old.ts",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "copied.ts, staged copied, copied from source.ts",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "both.ts, unstaged modified" }),
    );
    const source = await screen.findByLabelText("Source changes for both.ts");
    expect(source).toHaveAttribute("data-pane-scroll-active", "true");
    expect(within(pane).getByTitle("Line changes")).toHaveTextContent("+2−1");
    expect(screen.getByText("Source truncated")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next change" });
    fireEvent.click(next);
    expect(source.querySelector('[data-change-index="0"]')).toHaveClass(
      "source-diff__line--active",
    );
    fireEvent.click(next);
    expect(source.querySelector('[data-change-index="1"]')).toHaveClass(
      "source-diff__line--active",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "both.ts, staged modified" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "both.ts, staged modified" }),
      ).toHaveAttribute("aria-current", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: /image\.bin/ }));
    expect(await screen.findByText("Binary change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /conflict\.ts/ }));
    expect(await screen.findByText("Unresolved conflict")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /vendor\/module/ }));
    expect(await screen.findByText("Submodule change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /bad\\xff/ }));
    expect(await screen.findByText("Source unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(/cannot be represented as UTF-8/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new\.ts/ }));
    expect(
      await screen.findByRole("region", { name: "File source" }),
    ).toBeInTheDocument();
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
    fireEvent.click(await within(pane).findByRole("button", { name: "src" }));
    const browserScroller = pane.querySelector<HTMLElement>(
      ".files-browser__scroll",
    )!;
    browserScroller.scrollTop = 137;
    fireEvent.click(
      await within(pane).findByRole("button", { name: "long.ts" }),
    );
    expect(
      pane.querySelector(".files-browser")?.closest(".res__body"),
    ).toHaveAttribute("hidden");
    expect(
      within(pane).getByRole("button", {
        name: "Back to file browser for proj",
      }),
    ).toHaveTextContent("proj");

    expect(
      await within(pane).findByRole("region", { name: "File source" }),
    ).toHaveAttribute("data-pane-scroll-active", "true");
    expect(
      within(pane).getByRole("button", { name: "Preview" }),
    ).toBeDisabled();
    expect(
      within(pane).getByRole("button", { name: "Download long.ts" }),
    ).toBeInTheDocument();
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

    fireEvent.click(
      pane.querySelector<HTMLButtonElement>(".res__index-header--back")!,
    );
    expect(
      pane.querySelector(".files-browser")?.closest(".res__body"),
    ).not.toHaveAttribute("hidden");
    expect(pane.querySelector(".files-browser__scroll")).toBe(browserScroller);
    expect(browserScroller.scrollTop).toBe(137);
    expect(pane.querySelectorAll(".recent-files .recent-file")).toHaveLength(5);

    const search = within(pane).getByRole("searchbox", {
      name: "Search workspace files",
    });
    fireEvent.change(search, { target: { value: "main" } });
    expect(
      await within(pane).findByRole("button", {
        name: /main\.ts.*src\/main\.ts/,
      }),
    ).toBeInTheDocument();
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

    fireEvent.click(
      pane.querySelector<HTMLButtonElement>(".res__index-header--back")!,
    );
    expect(store.getState().selectedGitPathId).toBe("notes");
    fireEvent.click(within(pane).getByRole("button", { name: "Changes" }));
    expect(
      await within(pane).findByRole("button", {
        name: "notes.md, unstaged modified",
      }),
    ).toHaveAttribute("aria-current", "true");
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

  it("previews SVG and notebook files before offering their source", async () => {
    render(<App />);
    await store.openResource("diagram.svg");
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(within(pane).getByRole("button", { name: "Source" })).toBeEnabled();
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
    expect(within(pane).getByText("print('hello')")).toBeInTheDocument();
    expect(within(pane).getByText("hello")).toBeInTheDocument();
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
    expect(within(pane).getByText("File too large to preview")).toBeVisible();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(
      within(pane).getByRole("region", { name: "File source" }),
    ).toHaveTextContent("<svg");
    expect(within(pane).getByText("Preview ends here")).toBeVisible();
  });
});
