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
import type { ResourceProbeResult } from "../../shared/contracts";
import {
  MAX_RESOURCE_PROBE_REFERENCES,
  type SessionResourceReference,
  stripResourceLocation,
} from "../../shared/resource-references";
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
        const notesPath = {
          id: "notes",
          display: "notes.md",
          utf8Path: "notes.md",
          workspacePath: "notes.md",
        };
        if (url.startsWith("/api/git/status")) {
          gitStatusRequests += 1;
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
                      workspacePath: stripResourceLocation(reference),
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
          const html = resolvedPath.endsWith(".html");
          const truncatedHtml = resolvedPath.endsWith("truncated.html");
          const truncatedMarkdown = resolvedPath.endsWith("truncated.md");
          const largeSvg = resolvedPath.endsWith("large.svg");
          const text = resolvedPath.endsWith(".ts");
          const id = truncatedHtml
            ? "truncated-html"
            : html
              ? "html"
              : truncatedMarkdown
                ? "truncated-markdown"
                : largeSvg
                  ? "large-svg"
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
              : largeSvg
                ? "image/svg+xml"
                : text
                  ? "text/typescript"
                  : "text/markdown",
            size: largeSvg ? MAX_MEDIA_PREVIEW_BYTES + 1 : text ? 2_048 : 64,
            kind: html
              ? "html"
              : largeSvg
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
    await store.init();
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

  it("keeps one Recent list and marks the files tools wrote in this chat", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (!String(input).startsWith("/api/resources/list")) return response;
      const body = (await response.json()) as {
        resources: SessionResourceReference[];
      };
      if (body.resources[0]) body.resources[0].writes = true;
      return Response.json(body);
    });
    const { container } = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    await waitFor(() =>
      expect(container.querySelector(".recent-file")).not.toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "Files in this chat" }),
    ).toBeNull();
    const rows = [...container.querySelectorAll(".recent-file")];
    expect(rows.length).toBeGreaterThan(1);
    // Only the written file carries the pen and says so to assistive tech.
    expect(rows[0]!.querySelector(".recent-file__produced")).not.toBeNull();
    expect(rows[0]).toHaveAccessibleName(/written in this chat/);
    expect(rows[1]!.querySelector(".recent-file__produced")).toBeNull();
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
    expect(within(pane).getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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

  it("restores Browse scroll after leaving a file reader", async () => {
    store.showFileBrowser();
    const { container } = render(<ContextPane />);
    await screen.findByRole("button", { name: "README.md" });
    container.querySelector<HTMLElement>(".files-browser__scroll")!.scrollTop =
      137;
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    await screen.findByRole("tab", { name: "README.md", selected: true });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(
      container.querySelector<HTMLElement>(".files-browser__scroll")!.scrollTop,
    ).toBe(137);
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
      expect(store.getState().resourceStanding["notes.md"]?.workspacePath).toBe(
        "notes.md",
      ),
    );

    let releaseList: (() => void) | undefined;
    resourceListGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const batchCount = Math.ceil(
      resourceListRequests[0]!.limit! / MAX_RESOURCE_PROBE_REFERENCES,
    );
    await waitFor(() => expect(resourceProbeRequests).toBe(batchCount));
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
    expect(resourceProbeRequests).toBe(probesBefore);
    expect(
      within(pane).getByRole("button", { name: /notes\.md/ }),
    ).toBeVisible();
    expect(store.getState().resourceStanding["notes.md"]?.workspacePath).toBe(
      "notes.md",
    );
    expect(within(pane).queryByText("Loading recent files…")).toBeNull();
    expect(
      within(pane).queryByRole("button", { name: /fresh\.md/ }),
    ).toBeNull();

    act(() => releaseList?.());
    expect(
      await within(pane).findByRole("button", { name: /fresh\.md/ }),
    ).toBeVisible();
    expect(
      within(pane).queryByRole("button", { name: /notes\.md/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(resourceProbeRequests).toBe(probesBefore + batchCount),
    );
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
      await store.init();
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

  it("honors a Recent line reference when it reuses an open Preview tab", async () => {
    resourceListHead = "notes.md#L3";
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computedStyle(element);
      if (element.classList.contains("source-view")) style.lineHeight = "20px";
      return style;
    });
    render(<App />);
    await act(async () => {
      await store.openResource("notes.md");
    });
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByRole("heading", { name: "Previewed notes" }),
    ).toBeVisible();
    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    fireEvent.scroll(
      within(pane).getByRole("region", { name: "File source" }),
      {
        target: { scrollTop: 17 },
      },
    );
    fireEvent.click(within(pane).getByRole("button", { name: "Preview" }));
    fireEvent.click(within(pane).getByRole("tab", { name: "Files" }));
    await waitFor(() =>
      expect(
        store.getState().resourceStanding["notes.md#L3"]?.workspacePath,
      ).toBe("notes.md"),
    );
    fireEvent.click(within(pane).getByRole("button", { name: /^notes\.md/ }));
    const source = await within(pane).findByRole("region", {
      name: "File source",
    });
    expect(source.scrollTop).toBe(40);
    expect(store.getState().resourceTabs).toMatchObject([
      { reference: "notes.md" },
    ]);
    fireEvent.scroll(source, { target: { scrollTop: 27 } });
    await act(async () => {
      await store.refreshFileTab();
    });
    expect(
      within(pane).getByRole("region", { name: "File source" }).scrollTop,
    ).toBe(27);

    // A conversation link may open the same file before Recent has probed it.
    await act(async () => store.openResource("notes.md:2"));
    expect(
      within(pane).getByRole("region", { name: "File source" }).scrollTop,
    ).toBe(20);
    expect(store.getState().resourceTabs).toMatchObject([
      { reference: "notes.md" },
    ]);
  });

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
    expect(store.getState().resourceStanding["notes.md"]?.workspacePath).toBe(
      "notes.md",
    );

    act(() => releaseProbe?.());
    await waitFor(() =>
      expect(
        store.getState().resourceStanding["demo.html"]?.workspacePath,
      ).toBe("demo.html"),
    );
    expect(store.getState().resourceStanding["notes.md"]).toMatchObject({
      availability: "available",
      workspacePath: "notes.md",
    });
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
      await store.refreshGitStatus();
      if (view === "file") await store.openGitDiff("notes");
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
        pending = store.refreshGitStatus();
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

  it("uses summary cadence while reading a body and refreshes immediately on returning to Files", async () => {
    const view = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle resources panel" }),
    );
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    await within(pane).findByRole("button", { name: "README.md" });
    vi.useFakeTimers();
    try {
      await act(async () => {
        await store.openResource("notes.md");
      });
      const calls = gitStatusRequests;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(19_999);
      });
      expect(gitStatusRequests).toBe(calls);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(gitStatusRequests).toBe(calls + 1);
      await act(async () => {
        fireEvent.click(within(pane).getByRole("tab", { name: "Files" }));
      });
      expect(gitStatusRequests).toBe(calls + 2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("marks only an explicit refresh busy and prevents duplicate requests until it settles", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("changes");
    await store.refreshGitStatus();
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
      await store.refreshGitStatus();
      await store.openGitDiff("notes");
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
      expect(store.getState().resourceStanding["demo.html"]).toMatchObject({
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
      expect(store.getState().resourceStanding["old-1.md"]).toMatchObject({
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

  it("follows a file link in a document opened from the transcript", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "notes" }));
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    fireEvent.click(
      await within(pane).findByRole("link", { name: "Open main" }),
    );
    expect(
      await within(pane).findByRole("button", {
        name: "Copy path src/main.ts",
      }),
    ).toBeInTheDocument();
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

  it("marks a truncated rendered preview and preserves the source boundary", async () => {
    render(<App />);
    await store.openResource("truncated.md");
    const pane = await screen.findByRole("complementary", {
      name: "Context panel",
    });
    expect(
      await within(pane).findByText(
        "Preview truncated. See the cutoff in Source.",
      ),
    ).toBeVisible();

    fireEvent.click(within(pane).getByRole("button", { name: "Source" }));
    expect(within(pane).getByText("Preview ends here")).toBeVisible();
    expect(
      within(pane).queryByText("Preview truncated. See the cutoff in Source."),
    ).toBeNull();

    await act(async () => {
      await store.openResource("truncated.html");
    });
    expect(
      await within(pane).findByText(
        "Preview truncated. See the cutoff in Source.",
      ),
    ).toBeVisible();
    expect(within(pane).getByTitle("Preview truncated.html")).toHaveAttribute(
      "sandbox",
      "",
    );
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
