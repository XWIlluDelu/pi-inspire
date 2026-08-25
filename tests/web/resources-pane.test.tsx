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
  let resourceListRequests: Array<{ cursor?: string; limit?: number }> = [];
  let resourceProbeRequests = 0;
  let bootstrapMessages: unknown[] = [];
  let transcriptRevision = 1;

  beforeEach(async () => {
    gitStatusFails = false;
    missingProbeReference = null;
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
          const html = resolvedPath.endsWith(".html");
          const text = resolvedPath.endsWith(".ts");
          return Response.json({
            id: html ? "html" : text ? "text" : "markdown",
            sessionId: "s1",
            reference: body.reference,
            workspacePath: resolvedPath,
            name: resolvedPath.split("/").at(-1) ?? resolvedPath,
            mimeType: html
              ? "text/html"
              : text
                ? "text/typescript"
                : "text/markdown",
            size: text ? 2_048 : 64,
            kind: html ? "html" : text ? "text" : "markdown",
          });
        }
        if (url.includes("/api/resources/markdown/content"))
          return new Response("# Previewed notes");
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

  it("renders grouped canonical changes, side selection, numbered diffs, and explicit result states", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(pane.querySelector(".ctx__branch")).toHaveTextContent("notes.md");
    expect(
      screen.getByRole("heading", { name: /Conflicts/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Staged/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Unstaged/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "notes.md, unstaged modified",
        }),
      ).toHaveAttribute("aria-current", "true"),
    );
    expect(
      screen.getByLabelText("Untracked — not yet added to Git"),
    ).toHaveTextContent("U");
    expect(
      screen.getByLabelText("Untracked — not yet added to Git"),
    ).toHaveClass("git-deco--untracked");
    expect(
      screen.getByText("Showing first 11 of 1005 changed paths."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "both.ts, staged modified" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "both.ts, unstaged modified" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "conflict.ts, conflict UU" }),
    ).toBeInTheDocument();
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
    expect(
      await screen.findByLabelText("Diff for both.ts"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Working" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Old line 1")).toHaveTextContent("1");
    expect(screen.getByLabelText("New line 1")).toHaveTextContent("1");
    expect(
      screen.getByText("Diff truncated at the safe preview limit."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Staged" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Staged" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /image\.bin/ }));
    expect(await screen.findByText("Binary change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /conflict\.ts/ }));
    expect(await screen.findByText("Unresolved conflict")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /vendor\/module/ }));
    expect(await screen.findByText("Submodule change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /bad\\xff/ }));
    expect(
      await screen.findByText(/cannot be passed safely as UTF-8/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new\.ts/ }));
    expect(
      await screen.findByText(
        /Untracked content is available through File preview/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "File" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /outside\.ts/ }));
    expect(
      await screen.findByText(/outside the session workspace/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /gone\.ts/ }));
    expect(
      await screen.findByText(/working-tree file is deleted/i),
    ).toBeInTheDocument();
  });

  it("browses, searches, previews, locates, and adds workspace files", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );

    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(await within(pane).findByText("proj")).toBeInTheDocument();
    fireEvent.click(await within(pane).findByRole("button", { name: "src" }));
    const browserScroller = pane.querySelector<HTMLElement>(
      ".files-browser__scroll",
    )!;
    browserScroller.scrollTop = 137;
    fireEvent.click(
      await within(pane).findByRole("button", { name: "long.ts" }),
    );
    expect(pane.querySelector(".files-browser")).toHaveAttribute("hidden");

    expect(
      await within(pane).findByRole("region", { name: "File source" }),
    ).toHaveAttribute("data-pane-scroll-active", "true");
    const source = within(pane).getByRole("region", { name: "File source" });
    const targetLine = source.querySelector<HTMLElement>(
      '[data-source-line="80"]',
    )!;
    Object.defineProperty(source, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(targetLine, "offsetTop", {
      configurable: true,
      value: 600,
    });
    const line = within(pane).getByRole("spinbutton", { name: "Go to line" });
    fireEvent.change(line, { target: { value: "80" } });
    fireEvent.submit(line.closest("form")!);
    expect(source.scrollTop).toBe(500);

    fireEvent.click(
      within(pane).getByRole("button", { name: "Add to prompt" }),
    );
    expect(
      await screen.findByRole("list", { name: "Referenced project files" }),
    ).toHaveTextContent("src/long.ts");

    fireEvent.click(
      within(pane).getByRole("button", { name: "Back to files" }),
    );
    expect(pane.querySelector(".files-browser")).not.toHaveAttribute("hidden");
    expect(pane.querySelector(".files-browser__scroll")).toBe(browserScroller);
    expect(browserScroller.scrollTop).toBe(137);
    expect(pane.querySelectorAll(".recent-files .recent-file")).toHaveLength(5);

    await store.openResource("src/long.ts#L100");
    await waitFor(() =>
      expect(
        within(pane).getByRole("spinbutton", { name: "Go to line" }),
      ).toHaveValue(100),
    );
    fireEvent.click(
      within(pane).getByRole("button", { name: "Back to files" }),
    );
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

  it("refreshes the Files sources without coupling them to Git status", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByText("README.md");

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
    expect(missing).toHaveClass("recent-file--unavailable");
    expect(missing).toHaveAttribute(
      "title",
      expect.stringContaining("not found"),
    );
  });

  it("opens transcript references and keeps HTML isolated", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("heading", { name: "Previewed notes" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute(
      "target",
      "_blank",
    );

    fireEvent.click(screen.getByRole("link", { name: "page" }));
    fireEvent.click(
      await within(pane).findByRole("button", { name: "Sandbox" }),
    );
    const frame = await within(pane).findByTitle("Preview demo.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(URL.createObjectURL).toHaveBeenCalled();

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
});
