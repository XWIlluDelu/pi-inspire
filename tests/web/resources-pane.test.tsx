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
import type { GitPathIdentity } from "../../shared/contracts";
import { App } from "../../src/App";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
} from "./helpers";

function scrollResourceListToEnd(list: HTMLElement): void {
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 2_304 },
    clientHeight: { configurable: true, value: 320 },
    scrollTop: { configurable: true, value: 2_000, writable: true },
  });
  fireEvent.scroll(list);
}

describe("Files pane", () => {
  let gitStatusFails = false;
  let missingProbeReference: string | null = null;
  let resourceListFails = false;
  let resourceListFailureCursor: string | null = null;
  let resourceListRequests: Array<{ cursor?: string; limit?: number }> = [];
  let bootstrapMessages: unknown[] = [];
  let transcriptRevision = 1;

  beforeEach(async () => {
    gitStatusFails = false;
    missingProbeReference = null;
    resourceListFails = false;
    resourceListFailureCursor = null;
    resourceListRequests = [];
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
                messages: bootstrapMessages,
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
          if (resourceListFails || body.cursor === resourceListFailureCursor) {
            return Response.json(
              { error: "Reference index unavailable" },
              { status: 503 },
            );
          }
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
                : { reference, availability: "available" },
            ),
          });
        }
        if (url.startsWith("/api/resources/resolve")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            reference: string;
          };
          const html = body.reference.endsWith(".html");
          return Response.json({
            id: html ? "html" : "markdown",
            sessionId: "s1",
            reference: body.reference,
            name: body.reference,
            mimeType: html ? "text/html" : "text/markdown",
            size: 64,
            kind: html ? "html" : "markdown",
          });
        }
        if (url.includes("/api/resources/markdown/content"))
          return new Response("# Previewed notes");
        if (url.includes("/api/resources/html/content")) {
          return new Response(
            '<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script><h1>Safe page</h1></body></html>',
          );
        }
        return Response.json({ error: `unhandled ${url}` }, { status: 404 });
      }),
    );
    await store.init("token");
  });

  it("renders grouped canonical changes, side selection, numbered diffs, and explicit result states", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    expect(within(pane).getByText("feature/git")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Conflicts/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Staged/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Unstaged/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Untracked/ }),
    ).toBeInTheDocument();
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
    expect(screen.getByText("renamed from old.ts")).toBeInTheDocument();
    expect(screen.getByText("copied from source.ts")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /both\.ts/ })[1]!);
    expect(
      await screen.findByLabelText("Diff for both.ts"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unstaged" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Old line 1")).toHaveTextContent("1");
    expect(screen.getByLabelText("New line 1")).toHaveTextContent("1");
    expect(screen.getByText(/Truncated — complete lines/)).toBeInTheDocument();
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
      await screen.findByText("Unsupported path encoding"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new\.ts/ }));
    expect(
      await screen.findByText("Untracked diff unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open File" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /outside\.ts/ }));
    expect(
      await screen.findByText(/outside the session workspace/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /gone\.ts/ }));
    expect(
      await screen.findByText(/working-tree file is deleted/),
    ).toBeInTheDocument();
  });

  it("refreshes files without requesting Git status", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    await waitFor(() =>
      expect(
        within(pane)
          .getByLabelText("Referenced files")
          .querySelectorAll(".res__row").length,
      ).toBeGreaterThan(0),
    );
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const refresh = screen.getByRole("button", { name: "Refresh files" });
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(
        (fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(callsBefore),
    );
    const refreshCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .slice(callsBefore)
      .map(([input]) => String(input));
    expect(
      refreshCalls.some((url) => url.startsWith("/api/resources/list")),
    ).toBe(true);
    await waitFor(() =>
      expect(
        (fetch as ReturnType<typeof vi.fn>).mock.calls
          .slice(callsBefore)
          .map(([input]) => String(input))
          .some((url) => url.startsWith("/api/resources/probe")),
      ).toBe(true),
    );
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls
        .slice(callsBefore)
        .map(([input]) => String(input))
        .some((url) => url.startsWith("/api/git/status")),
    ).toBe(false);
  });

  it("loads earlier files one bounded page at a time and virtualizes the mounted rows", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    const list = within(pane).getByLabelText("Referenced files");
    await waitFor(() =>
      expect(list.querySelectorAll(".res__row")).toHaveLength(8),
    );
    fireEvent.click(
      await within(pane).findByRole("button", { name: "Earlier files (142)" }),
    );

    await waitFor(() => expect(resourceListRequests).toHaveLength(2));
    expect(resourceListRequests).toEqual([
      {},
      { cursor: "cursor:8", limit: 64 },
    ]);
    expect(
      within(pane).getByText("More files load as you scroll"),
    ).toBeInTheDocument();
    expect(list.querySelectorAll(".res__row").length).toBeLessThan(72);

    scrollResourceListToEnd(list);
    await waitFor(() => expect(resourceListRequests).toHaveLength(3));
    expect(resourceListRequests.at(-1)).toEqual({
      cursor: "cursor:72",
      limit: 64,
    });

    fireEvent.click(within(pane).getByRole("button", { name: "Recent files" }));
    expect(list.querySelectorAll(".res__row")).toHaveLength(8);
    expect(
      within(pane).getByRole("button", { name: "Earlier files (142)" }),
    ).toBeInTheDocument();
  });

  it("keeps earlier files expanded when the current transcript revision advances", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    fireEvent.click(
      await within(pane).findByRole("button", { name: "Earlier files (142)" }),
    );
    await waitFor(() => expect(resourceListRequests).toHaveLength(2));
    expect(
      within(pane).getByRole("button", { name: "Recent files" }),
    ).toHaveAttribute("aria-expanded", "true");

    transcriptRevision = 2;
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          messages: bootstrapMessages,
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
      });
    });

    await waitFor(() => expect(resourceListRequests).toHaveLength(4));
    expect(resourceListRequests.slice(-2)).toEqual([
      {},
      { cursor: "cursor:8", limit: 64 },
    ]);
    expect(
      within(pane).getByRole("button", { name: "Recent files" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(pane).queryByRole("button", { name: /Earlier files/ }),
    ).not.toBeInTheDocument();
  });

  it("retries one failed page without automatically draining the remaining cursor", async () => {
    resourceListFailureCursor = "cursor:72";
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    const list = within(pane).getByLabelText("Referenced files");
    fireEvent.click(
      await within(pane).findByRole("button", { name: "Earlier files (142)" }),
    );
    await waitFor(() => expect(resourceListRequests).toHaveLength(2));
    scrollResourceListToEnd(list);
    const retry = await within(pane).findByRole("button", {
      name: "Retry earlier files",
    });
    expect(list.querySelector(".res__virtual")).toHaveStyle({
      height: "2304px",
    });
    expect(list.querySelectorAll(".res__row").length).toBeLessThan(72);

    resourceListFailureCursor = null;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        resourceListRequests.filter(({ cursor }) => cursor === "cursor:72"),
      ).toHaveLength(2),
    );
    expect(
      within(pane).queryByRole("button", { name: "Retry earlier files" }),
    ).not.toBeInTheDocument();
    expect(
      within(pane).getByText("More files load as you scroll"),
    ).toBeInTheDocument();
    expect(
      resourceListRequests.some(({ cursor }) => cursor === "cursor:136"),
    ).toBe(false);
  });

  it("offers retry when an older-file index fails with no references on the current page", async () => {
    bootstrapMessages = [];
    resourceListFails = true;
    await store.init("token");
    store.clearResourceSelection();
    store.setResourcesOpen(true);
    render(<App />);

    const pane = await screen.findByRole("complementary", {
      name: "Files and resources",
    });
    expect(
      await within(pane).findByText("Earlier files unavailable"),
    ).toBeInTheDocument();
    expect(within(pane).queryByText("No files yet")).not.toBeInTheDocument();

    resourceListFails = false;
    fireEvent.click(within(pane).getByRole("button", { name: "Retry" }));
    const list = await within(pane).findByLabelText("Referenced files");
    await waitFor(() =>
      expect(list.querySelectorAll(".res__row")).toHaveLength(8),
    );
  });

  it("marks a missing reference from preflight before the row is selected", async () => {
    missingProbeReference = "demo.html";
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    const missing = await screen.findByRole("button", {
      name: /demo\.html.*missing/i,
    });
    expect(missing).toHaveClass("res__row--unavailable");
    expect(missing).toHaveAttribute(
      "title",
      expect.stringContaining("not found"),
    );
    expect(screen.queryByText("Preview failed")).not.toBeInTheDocument();
  });

  it("opens conversation file references and isolates HTML without restoring session metadata", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));

    expect(
      await screen.findByRole("complementary", { name: "Files and resources" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Previewed notes" }),
    ).toBeInTheDocument();
    const notesRow = screen.getByRole("button", {
      name: /notes\.md.*unstaged modified/i,
    });
    expect(notesRow).toBeInTheDocument();
    expect(notesRow.querySelector(".res__row-name")).toHaveClass(
      "git-deco--modified",
    );
    expect(within(notesRow).getByLabelText("unstaged modified")).toHaveClass(
      "git-deco--modified",
    );
    expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute(
      "target",
      "_blank",
    );

    fireEvent.click(screen.getByRole("link", { name: "page" }));
    expect(
      await screen.findByText("Open in sandboxed view"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open in sandboxed view" }),
    );
    const frame = await screen.findByTitle("Sandboxed preview of demo.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(URL.createObjectURL).toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle resources panel" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Files and resources" }),
      ).not.toBeInTheDocument(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
