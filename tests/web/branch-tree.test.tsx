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
  BranchTreeNode,
  BranchTreeResponse,
} from "../../shared/contracts";
import { BranchTree } from "../../src/components/BranchTree";
import { Composer } from "../../src/components/Composer";
import { EarlierBranchBanner } from "../../src/components/EarlierBranchBanner";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
} from "./helpers";

const point = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  snippet: string,
  leaf = false,
): BranchTreeNode => ({
  id,
  parentId,
  role,
  snippet,
  label: snippet,
  type: "message",
  depth: 0,
  timestamp: "2026-08-01",
  active: true,
  leaf,
  canSwitch: role === "assistant",
  canEdit: role === "user",
  canFork: role === "user",
});
const nodes = [
  point("u1", null, "user", "Root question"),
  point("a1", "u1", "assistant", "Earlier answer"),
  point("u2", "a1", "user", "Revised question"),
  point("a2", "u2", "assistant", "Latest answer", true),
];
const longAnswer = `${"Complete retained response. ".repeat(1500)}old keyword beyond the snippet · 完整内容`;
const full = new Map(
  nodes.map((node) => [node.id, node.id === "a1" ? longAnswer : node.snippet]),
);

let fixture: {
  effective: string | null;
  revision: number;
  skip: boolean;
  paged: boolean;
  cancelled: boolean;
  activity?: "model" | "shell";
  searchGate?: Promise<void>;
  navigateGate?: Promise<void>;
  entryFailures?: number;
  imageFailures?: number;
  images?: boolean;
  detailText?: string;
  outline?: BranchTreeNode[];
};
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
function tree(query = ""): BranchTreeResponse {
  const url = new URL(query || "/", "http://fixture");
  const search = url.searchParams.get("query");
  const before = url.searchParams.get("before");
  const selected = search
    ? nodes.filter((node) => full.get(node.id)!.includes(search))
    : fixture.paged
      ? before
        ? nodes.slice(0, 3)
        : nodes.slice(3)
      : (fixture.outline ?? nodes);
  return {
    sessionId: "s1",
    revision: fixture.revision,
    incarnation: "history-fixture",
    durableLeafId: "a2",
    effectiveLeafId: fixture.effective,
    activePath: nodes.filter((node) => node.active).map((node) => node.id),
    nodes: selected,
    truncated: fixture.paged && !before && !search,
    nextBefore: fixture.paged && !before && !search ? "a2" : null,
    ...(fixture.paged && !before && !search ? { leadingPrompt: nodes[2] } : {}),
    skipSummaryPrompt: fixture.skip,
    rootCount: 1,
    health: { status: "ok" },
  };
}

beforeEach(async () => {
  fixture = {
    effective: "a2",
    revision: 1,
    skip: false,
    paged: false,
    cancelled: false,
  };
  requests.length = 0;
  installFakeWebSocket();
  setSessionDraft("s1", "");
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      requests.push({ url, body });
      if (url.startsWith("/api/bootstrap"))
        return Response.json(
          bootstrapPayload({
            snapshot: {
              ...activeSnapshot({
                durableLeafId: "a2",
                effectiveLeafId: fixture.effective,
              }),
              runState: fixture.activity === "model" ? "running" : "idle",
              bashRunning: fixture.activity === "shell",
            },
          }),
        );
      if (url.startsWith("/api/sessions"))
        return Response.json({ sessions: [], total: 0, offset: 0, limit: 40 });
      if (url.startsWith("/api/branches/tree")) {
        if (new URL(url, "http://fixture").searchParams.has("query"))
          await fixture.searchGate;
        return Response.json(tree(url));
      }
      if (url.startsWith("/api/branches/image")) {
        if (fixture.imageFailures) {
          fixture.imageFailures--;
          return Response.json(
            { error: "Temporary image failure" },
            { status: 503 },
          );
        }
        return new Response("fixture image", {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.startsWith("/api/branches/entry")) {
        if (fixture.entryFailures) {
          fixture.entryFailures--;
          return Response.json(
            { error: "Preview temporarily unavailable" },
            { status: 503 },
          );
        }
        const query = new URL(url, "http://fixture").searchParams;
        const id = query.get("targetId")!;
        const text = fixture.detailText ?? full.get(id)!;
        const offset = Number(query.get("offset") ?? 0);
        const end = Math.min(text.length, offset + 32000);
        return Response.json({
          sessionId: "s1",
          revision: fixture.revision,
          node: nodes.find((node) => node.id === id),
          text: text.slice(offset, end),
          nextOffset: end < text.length ? end : null,
          totalChars: text.length,
          ...(fixture.images
            ? { images: [{ index: 1, mimeType: "image/png" }] }
            : {}),
        });
      }
      if (url === "/api/branches/navigate") {
        await fixture.navigateGate;
        const node = nodes.find((node) => node.id === body.targetId)!;
        if (!fixture.cancelled) {
          fixture.effective = node.canEdit ? node.parentId : node.id;
          fixture.revision++;
        }
        return Response.json({
          snapshot: activeSnapshot({
            durableLeafId: "a2",
            effectiveLeafId: fixture.effective,
            transcriptPage: {
              sessionId: "s1",
              revision: fixture.revision,
              viewId: fixture.cancelled ? "view-1" : "changed-view",
              effectiveLeafId: fixture.effective,
              messages: [],
              hasOlder: false,
              olderCursor: null,
            },
          }),
          ...(fixture.cancelled
            ? { cancelled: true }
            : node.canEdit
              ? { editorText: full.get(node.id) }
              : {}),
        });
      }
      if (url === "/api/branches/fork" || url === "/api/branches/clone") {
        const fork = url.endsWith("fork");
        const id = fork ? "forked" : "cloned";
        return Response.json({
          sessionId: id,
          editorText: fork ? full.get(String(body.targetId)) : "",
          snapshot: activeSnapshot({
            sessionId: id,
            sessionName: id,
            durableLeafId: null,
            effectiveLeafId: null,
            pageMessages: [],
          }),
        });
      }
      return Response.json(
        { error: `Unhandled fixture request: ${url}` },
        { status: 404 },
      );
    }),
  );
  await store.init("token");
  for (const path of store.getState().projectFiles)
    store.removeProjectFile(path);
  await store.loadBranchTree();
});

function history() {
  return screen.getByRole("region", { name: "Conversation history" });
}
async function previewAnswer() {
  fireEvent.click(
    within(history()).getAllByRole("button", {
      name: "Replies and activity",
    })[0]!,
  );
  fireEvent.click(
    within(history()).getByRole("button", { name: "Response Earlier answer" }),
  );
  await screen.findByRole("button", { name: "Read more content" });
}

describe("read-only History inspection", () => {
  it("keeps first-input alternatives reachable through Other starts when their branch point is metadata", async () => {
    const setting: BranchTreeNode = {
      ...point("thinking", "model", "assistant", "off"),
      type: "thinking_level_change",
      role: "metadata",
      childCount: 2,
    };
    const model: BranchTreeNode = {
      ...setting,
      id: "model",
      parentId: null,
      type: "model_change",
      childCount: 1,
    };
    const original = { ...nodes[0]!, parentId: setting.id, routeLeafId: "a1" };
    const current = { ...nodes[2]!, parentId: setting.id, routeLeafId: "a2" };
    fixture.outline = [model, setting, current, nodes[3]!];
    await store.loadBranchTree();
    const read = vi
      .spyOn(store, "readBranchTree")
      .mockImplementation(async (query) => ({
        ...tree(),
        routeLeafId: query.leafId ?? "a2",
        nodes: query.parentId
          ? [original, current]
          : [model, setting, original, nodes[1]!],
      }));
    render(<BranchTree />);
    fireEvent.click(screen.getByRole("button", { name: "Other starts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Root question/ }),
    );
    await screen.findByText("Inspecting another route");
    await screen.findByRole("button", { name: "Root question" });
    expect(read).toHaveBeenCalledWith(
      { parentId: "thinking" },
      expect.any(AbortSignal),
    );
    expect(read).toHaveBeenCalledWith(
      { leafId: "a1" },
      expect.any(AbortSignal),
    );
    expect(
      requests.some((request) => request.url === "/api/branches/navigate"),
    ).toBe(false);
  });

  it("retries only a failed image without discarding the selected entry or outline position", async () => {
    fixture.images = true;
    fixture.imageFailures = 1;
    render(<BranchTree />);
    const search = screen.getByRole("searchbox", { name: "Find in history" });
    fireEvent.change(search, { target: { value: "Root" } });
    const match = await screen.findByRole("button", {
      name: "Your input Root question",
    });
    expect(match.querySelector(".search-match")).toHaveTextContent(/^Root$/);
    const rows = history().querySelector(".branch-tree__rows")!;
    rows.scrollTop = 81;
    fireEvent.click(match);
    fireEvent.click(await screen.findByRole("button", { name: "Retry image" }));
    await screen.findByRole("button", {
      name: "Preview image in this history entry",
    });
    expect(
      requests.filter((request) =>
        request.url.startsWith("/api/branches/image"),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.url.startsWith("/api/branches/entry"),
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(search).toHaveValue("Root");
    expect(rows.scrollTop).toBe(81);
    expect(match).toHaveFocus();
  });

  it("delegates inline-code and Markdown local files to the session reader, not external links", async () => {
    fixture.detailText =
      "Read `README.md` or [the document](README.md), and [external docs](https://example.com/docs).";
    const open = vi.spyOn(store, "openResource").mockResolvedValue();
    render(<BranchTree />);
    fireEvent.click(screen.getByRole("button", { name: "Root question" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const link = screen.getByRole("link", { name: "the document" });
    expect(fireEvent.click(link)).toBe(false);
    expect(open.mock.calls).toEqual([["README.md"], ["README.md"]]);
    const external = screen.getByRole("link", { name: "external docs" });
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(external).toHaveAttribute("target", "_blank");
    expect(fireEvent.click(external)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it("leads with prompts and keeps reply selection separate from continuation", async () => {
    setSessionDraft("s1", "unsent draft");
    const before = store.getState().transcriptViewId;
    render(<BranchTree />);
    expect(
      within(history()).getByRole("button", { name: "Root question" }),
    ).toBeInTheDocument();
    expect(
      within(history()).getByRole("button", {
        name: /Revised question Current conversation/,
      }),
    ).toBeInTheDocument();
    expect(
      within(history()).queryByText("Earlier answer"),
    ).not.toBeInTheDocument();
    await previewAnswer();
    expect(store.getState().transcriptViewId).toBe(before);
    expect(sessionDraft("s1")).toBe("unsent draft");
    expect(
      requests.filter((request) => request.url === "/api/branches/navigate"),
    ).toEqual([]);
    expect(screen.getByRole("button", { name: "Continue here" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Back to history" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("button", { name: "Response Earlier answer" }),
    ).toHaveFocus();
  });

  it("searches full retained content, reads every chunk, and restores search/scroll/focus", async () => {
    render(<BranchTree />);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find in history" }),
      { target: { value: "old keyword" } },
    );
    const match = await screen.findByRole("button", {
      name: "Response Earlier answer",
    });
    const rows = history().querySelector(".branch-tree__rows")!;
    rows.scrollTop = 137;
    fireEvent.click(match);
    fireEvent.click(
      await screen.findByRole("button", { name: "Read more content" }),
    );
    await screen.findByText(/old keyword beyond the snippet · 完整内容/);
    expect(
      screen.queryByRole("button", { name: "Read more content" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(
      screen.getByRole("searchbox", { name: "Find in history" }),
    ).toHaveValue("old keyword");
    expect(rows.scrollTop).toBe(137);
    expect(match).toHaveFocus();
    expect(
      requests.filter((request) => request.url.includes("query=old")),
    ).toHaveLength(1);
  });

  it("retires a pending search when cleared without letting it retire the next read", async () => {
    fixture.paged = true;
    await store.loadBranchTree();
    const older = deferred<void>();
    fixture.searchGate = older.promise;
    render(<BranchTree />);
    const search = screen.getByRole("searchbox", { name: "Find in history" });
    fireEvent.change(search, { target: { value: "old keyword" } });
    await screen.findByLabelText("Searching history");
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() =>
      expect(history()).not.toHaveAttribute("aria-busy", "true"),
    );
    expect(
      screen.getByRole("button", { name: "Earlier conversation" }),
    ).toBeEnabled();
    const newer = deferred<void>();
    fixture.searchGate = newer.promise;
    fireEvent.change(search, { target: { value: "Root" } });
    await screen.findByLabelText("Searching history");
    await act(async () => older.resolve());
    expect(history()).toHaveAttribute("aria-busy", "true");
    await act(async () => newer.resolve());
    await waitFor(() =>
      expect(history()).not.toHaveAttribute("aria-busy", "true"),
    );
    expect(
      screen.getByRole("button", { name: "Your input Root question" }),
    ).toBeVisible();
  });

  it("retries a failed selected preview and keeps its search and Back anchor", async () => {
    render(<BranchTree />);
    const search = screen.getByRole("searchbox", { name: "Find in history" });
    fireEvent.change(search, { target: { value: "old keyword" } });
    const match = await screen.findByRole("button", {
      name: "Response Earlier answer",
    });
    const rows = history().querySelector(".branch-tree__rows")!;
    rows.scrollTop = 73;
    fixture.entryFailures = 1;
    fireEvent.click(match);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry preview" }),
    );
    await screen.findByRole("button", { name: "Read more content" });
    expect(
      requests.filter((request) =>
        request.url.startsWith("/api/branches/entry"),
      ),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(search).toHaveValue("old keyword");
    expect(rows.scrollTop).toBe(73);
    expect(match).toHaveFocus();
  });

  it("retains ordinary loaded older pages after preview and Back", async () => {
    fixture.paged = true;
    await store.loadBranchTree();
    const align = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<BranchTree />);
    expect(
      screen.queryByRole("button", { name: "Root question" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Revised question Current conversation/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Earlier conversation" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Root question" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit in this session" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(screen.getByRole("button", { name: "Root question" })).toHaveFocus();
    expect(align).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Earlier conversation" }),
    ).not.toBeInTheDocument();
    expect(
      requests.filter((request) => request.url.includes("before=a2")),
    ).toHaveLength(1);
  });
});

describe("explicit History actions", () => {
  it.each(["model", "shell"] as const)(
    "allows inspection and independent copying during %s work, but not same-session continuation",
    async (activity) => {
      fixture.activity = activity;
      await store.init("token");
      await store.loadBranchTree();
      render(<BranchTree />);
      await previewAnswer();
      expect(
        screen.getByRole("button", { name: "Continue here" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Clone through here" }),
      ).toBeEnabled();
      expect(
        screen.getByText(
          "Wait until the current task finishes before changing this conversation",
        ),
      ).toBeVisible();
    },
  );

  it("replaces a nonempty draft only after explicit Edit and offers optional native summary instructions", async () => {
    setSessionDraft("s1", "existing draft");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(<BranchTree />);
    fireEvent.click(screen.getByRole("button", { name: "Root question" }));
    const edit = await screen.findByRole("button", {
      name: "Edit in this session",
    });
    await waitFor(() => expect(edit).toBeEnabled());
    const sameSession = screen.getByRole("group", { name: "This session" });
    const summary = within(sameSession).getByRole("checkbox", {
      name: "Carry branch summary",
    });
    expect(summary).toHaveClass("choice-input");
    expect(summary).not.toBeChecked();
    expect(
      Array.from(sameSession.querySelectorAll("input, textarea, button")),
    ).toEqual([summary, edit]);
    fireEvent.click(edit);
    expect(
      requests.filter((request) => request.url === "/api/branches/navigate"),
    ).toHaveLength(0);
    expect(sessionDraft("s1")).toBe("existing draft");
    fireEvent.click(summary);
    const instructions = within(sameSession).getByRole("textbox", {
      name: "Summary instructions",
    });
    expect(instructions).toHaveAttribute("maxlength", "2000");
    expect(
      Array.from(sameSession.querySelectorAll("input, textarea, button")),
    ).toEqual([summary, instructions, edit]);
    expect(
      within(screen.getByRole("group", { name: "New session" })).queryByRole(
        "checkbox",
      ),
    ).not.toBeInTheDocument();
    fireEvent.change(instructions, {
      target: { value: "Keep the measurements" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit in this session" }),
    );
    await waitFor(() =>
      expect(
        requests.some((request) => request.url === "/api/branches/navigate"),
      ).toBe(true),
    );
    expect(
      requests.find((request) => request.url === "/api/branches/navigate")!
        .body,
    ).toEqual({
      sessionId: "s1",
      revision: 1,
      targetId: "u1",
      mode: "edit",
      summarize: true,
      customInstructions: "Keep the measurements",
    });
    await waitFor(() =>
      expect(store.getState().editorText?.text).toBe("Root question"),
    );
    expect(store.getState().transcriptEffectiveLeafId).toBeNull();
    expect(store.getState().branchActionId).toBeNull();
  });

  it.each(["text", "material"])(
    "keeps a newer %s edit while a confirmed History summary is pending",
    async (edit) => {
      const summary = deferred<void>();
      fixture.navigateGate = summary.promise;
      setSessionDraft("s1", "confirmed draft");
      render(
        <>
          <Composer />
          <BranchTree />
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Root question" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Edit in this session" }),
        ).toBeEnabled(),
      );
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "Carry branch summary",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Edit in this session" }),
      );
      await waitFor(() =>
        expect(store.getState().branchActionId).toBe("edit:u1"),
      );
      if (edit === "text") {
        fireEvent.change(screen.getByLabelText("Message"), {
          target: { value: "newer draft" },
        });
        // Even returning to the same text is a newer revision.
        fireEvent.change(screen.getByLabelText("Message"), {
          target: { value: "confirmed draft" },
        });
      } else act(() => store.addProjectFile("newer-image-notes.md"));
      await act(async () => summary.resolve());
      await waitFor(() => expect(store.getState().branchActionId).toBeNull());
      expect(store.getState().transcriptEffectiveLeafId).toBeNull();
      expect(screen.getByLabelText("Message")).toHaveValue("confirmed draft");
      expect(sessionDraft("s1")).toBe("confirmed draft");
      if (edit === "material")
        expect(store.getState().projectFiles).toEqual(["newer-image-notes.md"]);
    },
  );

  it("honors skip-summary-prompt and keeps a cancelled continuation at the source", async () => {
    fixture.skip = true;
    fixture.cancelled = true;
    await store.loadBranchTree();
    setSessionDraft("s1", "unsent draft");
    const revealConversation = vi.fn();
    render(<BranchTree onContextChange={revealConversation} />);
    await previewAnswer();
    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url === "/api/branches/navigate"),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(store.getState().branchActionId).toBeNull());
    expect(
      screen.queryByRole("checkbox", {
        name: "Carry branch summary",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to history" }),
    ).toBeInTheDocument();
    expect(store.getState().transcriptEffectiveLeafId).toBe("a2");
    expect(store.getState().branchTreeError).toBeNull();
    expect(revealConversation).not.toHaveBeenCalled();
    expect(sessionDraft("s1")).toBe("unsent draft");
  });

  it.each([
    ["Fork to new session", "u1"],
    ["Clone through here", "a1"],
    ["Clone through here", "u1"],
  ] as const)(
    "distinguishes %s at %s and preserves the source draft",
    async (action, targetId) => {
      setSessionDraft("s1", "source draft");
      const revealConversation = vi.fn();
      render(<BranchTree onContextChange={revealConversation} />);
      const fork = action.startsWith("Fork");
      if (targetId === "u1")
        fireEvent.click(screen.getByRole("button", { name: "Root question" }));
      else await previewAnswer();
      const button = await screen.findByRole("button", { name: action });
      await waitFor(() => expect(button).toBeEnabled());
      expect(
        within(screen.getByRole("group", { name: "New session" })).getByRole(
          "button",
          { name: action },
        ),
      ).toBe(button);
      fireEvent.click(button);
      await waitFor(() =>
        expect(store.getState().sessionId).toBe(fork ? "forked" : "cloned"),
      );
      expect(store.getState().editorText?.text).toBe(
        fork ? "Root question" : "",
      );
      expect(sessionDraft("s1")).toBe("source draft");
      expect(
        requests.find(
          (request) =>
            request.url === `/api/branches/${fork ? "fork" : "clone"}`,
        )?.body.targetId,
      ).toBe(targetId);
      await waitFor(() => expect(revealConversation).toHaveBeenCalledOnce());
      expect(window.confirm).not.toHaveBeenCalled();
    },
  );

  it("offers endpoint-inclusive Clone in the active earlier-history notice, not user-only Fork", async () => {
    fixture.effective = "a1";
    await store.init("token");
    await store.loadBranchTree();
    render(<EarlierBranchBanner />);
    expect(
      screen.getByText("Continuing from earlier history"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clone from here" }));
    await waitFor(() => expect(store.getState().sessionId).toBe("cloned"));
    expect(
      requests.filter((request) => request.url === "/api/branches/clone"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.url === "/api/branches/fork"),
    ).toHaveLength(0);
    expect(
      screen.queryByLabelText("Earlier branch context"),
    ).not.toBeInTheDocument();
  });
});
