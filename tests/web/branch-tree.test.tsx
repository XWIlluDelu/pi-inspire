// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { CommandPalette } from "../../src/components/CommandPalette";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
} from "./helpers";

const nodes = [
  {
    id: "u1",
    parentId: null,
    depth: 0,
    type: "message",
    role: "user",
    label: "user: root",
    snippet: "root",
    timestamp: "2026-08-01",
    active: true,
    leaf: false,
    canSwitch: false,
    canEdit: false,
    canFork: true,
  },
  {
    id: "a1",
    parentId: "u1",
    depth: 1,
    type: "message",
    role: "assistant",
    label: "assistant: answer",
    snippet: "answer",
    timestamp: "2026-08-01",
    active: true,
    leaf: false,
    canSwitch: true,
    canEdit: false,
    canFork: false,
  },
  {
    id: "u2",
    parentId: "a1",
    depth: 2,
    type: "message",
    role: "user",
    label: "user: revise",
    snippet: "revise",
    timestamp: "2026-08-01",
    active: true,
    leaf: false,
    canSwitch: false,
    canEdit: true,
    canFork: true,
  },
  {
    id: "a2",
    parentId: "u2",
    depth: 3,
    type: "message",
    role: "assistant",
    label: "assistant: latest",
    snippet: "latest",
    timestamp: "2026-08-01",
    active: true,
    leaf: true,
    canSwitch: true,
    canEdit: false,
    canFork: false,
  },
  {
    id: "branch",
    parentId: "a1",
    depth: 2,
    type: "message",
    role: "assistant",
    label: "assistant: sibling",
    snippet: "sibling",
    timestamp: "2026-08-01",
    active: false,
    leaf: false,
    canSwitch: true,
    canEdit: false,
    canFork: false,
  },
  {
    id: "u3",
    parentId: "branch",
    depth: 3,
    type: "message",
    role: "user",
    label: "user: alternate prompt",
    snippet: "alternate prompt",
    timestamp: "2026-08-01",
    active: false,
    leaf: false,
    canSwitch: false,
    canEdit: true,
    canFork: false,
  },
  {
    id: "a3",
    parentId: "u3",
    depth: 4,
    type: "message",
    role: "assistant",
    label: "assistant: alternate answer",
    snippet: "alternate answer",
    timestamp: "2026-08-01",
    active: false,
    leaf: false,
    canSwitch: true,
    canEdit: false,
    canFork: false,
  },
] as const;

function tree(sessionId = "s1", effectiveLeafId = "a2") {
  return {
    sessionId,
    revision: 1,
    incarnation: "tree-incarnation",
    durableLeafId: "a2",
    effectiveLeafId,
    activePath: ["u1", "a1", "u2", "a2"],
    nodes,
    truncated: false,
    health: { status: "ok" },
  };
}

describe("History contextual mode", () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(async () => {
    requests.length = 0;
    let effectiveLeafId = "a2";
    installFakeWebSocket();
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
              snapshot: activeSnapshot({
                durableLeafId: "a2",
                effectiveLeafId: "a2",
              }),
            }),
          );
        if (url.startsWith("/api/sessions"))
          return Response.json({
            sessions: [],
            total: 0,
            offset: 0,
            limit: 40,
          });
        if (url.startsWith("/api/git/status"))
          return Response.json({ kind: "not-repository" });
        if (url.startsWith("/api/branches/tree"))
          return Response.json(tree("s1", effectiveLeafId));
        if (url === "/api/branches/navigate") {
          effectiveLeafId = String(body.targetId);
          const messages = [
            { role: "assistant", content: "switched", timestamp: 9 },
          ];
          return Response.json({
            snapshot: activeSnapshot({
              durableLeafId: "a2",
              effectiveLeafId,
              pageMessages: messages,
              transcriptPage: {
                sessionId: "s1",
                revision: 2,
                viewId: `view-${effectiveLeafId}`,
                incarnation: "projection-1",
                appendFromRevision: 2,
                effectiveLeafId,
                messages,
                hasOlder: false,
                olderCursor: null,
              },
            }),
            ...(body.mode === "edit" ? { editorText: "revise" } : {}),
          });
        }
        if (url === "/api/branches/fork") {
          return Response.json({
            sessionId: "forked",
            snapshot: activeSnapshot({
              sessionId: "forked",
              sessionName: "Forked",
              pageMessages: [],
            }),
            editorText: "revise",
          });
        }
        return Response.json({ error: `unhandled ${url}` }, { status: 404 });
      }),
    );
    await store.init("token");
  });

  it("renders bounded ordered rows with keyboard-accessible switch, edit, and fork actions", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));

    const history = await screen.findByLabelText(
      "Conversation history and branches",
    );
    expect(history).toBeInTheDocument();
    expect(screen.getByText("3 turns · 1 fork")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit from here: user: root" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Current point: assistant: latest" }),
    ).toBeDisabled();
    const alternateTurn = screen
      .getByRole("button", { name: "Collapse activity for alternate prompt" })
      .closest(".branch-turn");
    expect(alternateTurn).toHaveStyle("--branch-lane: 1");
    const switchButton = screen.getByRole("button", {
      name: "Switch to point: assistant: sibling",
    });
    switchButton.focus();
    fireEvent.keyDown(switchButton, { key: "Enter" });
    fireEvent.click(switchButton);
    await waitFor(() =>
      expect(
        requests.some(
          ({ url, body }) =>
            url === "/api/branches/navigate" &&
            body.targetId === "branch" &&
            body.mode === "switch",
        ),
      ).toBe(true),
    );
    expect(confirm).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit from here: user: revise" }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByPlaceholderText("Message Pi…"), {
      target: { value: "unsent draft" },
    });
    const edit = screen.getByRole("button", {
      name: "Edit from here: user: revise",
    });
    fireEvent.click(edit);
    expect(confirm).toHaveBeenCalledWith(
      "Move to before this message and replace your current composer draft with its original text?",
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Message Pi…")).toHaveValue("revise"),
    );
    expect(
      requests.some(
        ({ url, body }) =>
          url === "/api/branches/navigate" &&
          body.targetId === "u2" &&
          body.mode === "edit",
      ),
    ).toBe(true);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fork from here: user: revise" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fork from here: user: revise" }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Message Pi…")).toHaveValue("revise"),
    );
    expect(store.getState().sessionId).toBe("forked");
    expect(
      requests.some(
        ({ url, body }) =>
          url === "/api/branches/fork" && body.targetId === "u2",
      ),
    ).toBe(true);
  });

  it("folds and searches loaded activity without flattening it into raw rows", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByLabelText("Conversation history and branches");

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse all activity" }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    ).not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", {
      name: "Search loaded history",
    });
    fireEvent.change(search, { target: { value: "sibling" } });
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(screen.getByText("1 matching event")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Edit from here: user: alternate prompt",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand activity for root" }),
    );
    expect(
      screen.getByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).not.toHaveFocus();
    expect(
      screen.getByRole("button", {
        name: "Edit from here: user: alternate prompt",
      }),
    ).toBeInTheDocument();
  });

  it("keeps an earlier branch visible with explicit return and fork actions", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByLabelText("Conversation history and branches");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    );

    const banner = await screen.findByText("Viewing an earlier branch");
    expect(banner.closest(".earlier-branch-banner")).toBeInTheDocument();
    // It remains in the central transcript context when the History panel is
    // closed or another resource mode takes its place.
    store.setContextMode("files");
    expect(screen.getByText("Viewing an earlier branch")).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back to latest" });
    fireEvent.click(back);
    await waitFor(() =>
      expect(
        requests.some(
          ({ url, body }) =>
            url === "/api/branches/navigate" &&
            body.targetId === "a2" &&
            body.mode === "switch",
        ),
      ).toBe(true),
    );
  });

  it("offers a current earlier-branch return in the command palette", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByLabelText("Conversation history and branches");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    );
    await screen.findByText("Viewing an earlier branch");

    render(
      <CommandPalette
        onClose={() => undefined}
        onToggleNav={() => undefined}
        onToggleCtx={() => undefined}
        onNewSession={() => undefined}
        onOpenSession={() => undefined}
      />,
    );
    expect(
      screen.getByRole("option", {
        name: /\/compact.*Compact the current context/,
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter commands"), {
      target: { value: "latest branch" },
    });
    expect(
      screen.getByRole("option", { name: "Back to latest branch" }),
    ).toBeInTheDocument();
  });

  it("keeps the last tree visible with explicit stale and truncated states", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByLabelText("Conversation history and branches");

    // A projection update makes actions visibly stale until refresh.
    const socket = (globalThis as unknown as { __unused?: unknown }).__unused;
    void socket;
    // Exercise the store's explicit stale presentation without mutating the tree.
    (store as unknown as { set(partial: unknown): void }).set({
      branchTreeError:
        "Branch history is stale — refresh to use branch actions",
    });
    expect(
      await screen.findByText(/Branch history is stale/),
    ).toBeInTheDocument();
    expect(screen.getByText("sibling")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    ).toBeDisabled();
    const actionRequests = requests.filter(
      ({ url }) =>
        url === "/api/branches/navigate" || url === "/api/branches/fork",
    ).length;
    await expect(store.navigateBranch("branch", "switch")).resolves.toBe(false);
    await expect(store.forkBranch("u2")).resolves.toBe(false);
    expect(
      requests.filter(
        ({ url }) =>
          url === "/api/branches/navigate" || url === "/api/branches/fork",
      ),
    ).toHaveLength(actionRequests);

    (store as unknown as { set(partial: unknown): void }).set({
      branchTreeError: null,
      projectionHealth: { status: "error", message: "projection failed" },
    });
    await expect(store.navigateBranch("branch", "switch")).resolves.toBe(false);
    expect(
      screen.getByRole("button", {
        name: "Switch to point: assistant: sibling",
      }),
    ).toBeDisabled();

    (store as unknown as { set(partial: unknown): void }).set({
      branchTree: { ...tree(), truncated: true },
      projectionHealth: { status: "ok" },
    });
    expect(
      await screen.findByText("Earlier entries omitted"),
    ).toBeInTheDocument();

    const longNodes = Array.from({ length: 500 }, (_, index) => ({
      id: `event-${index}`,
      parentId: index > 0 ? `event-${index - 1}` : null,
      childIds: index < 499 ? [`event-${index + 1}`] : [],
      activeChildId: index < 499 ? `event-${index + 1}` : null,
      type: "tool_result",
      role: "tool",
      label: `event ${index}`,
      timestamp: "2026-08-22T00:00:00.000Z",
      createdAtMs: index,
      depth: index,
      activePath: true,
      branchNode: false,
      leaf: index === 499,
      subtreeEnd: 500,
      canSwitch: index !== 499,
      canEdit: false,
      canFork: false,
      metadata: false,
      durationMs: null,
      usage: null,
    }));
    (store as unknown as { set(partial: unknown): void }).set({
      branchTree: {
        ...tree(),
        durableLeafId: "event-499",
        effectiveLeafId: "event-499",
        activePath: longNodes.map(({ id }) => id),
        nodes: longNodes,
        truncated: true,
      },
    });
    expect(
      await screen.findByText("500 entries · bounded"),
    ).toBeInTheDocument();
    const expandBoundedActivity = screen.getByRole("button", {
      name: "Expand activity for Activity before the loaded boundary",
    });
    expect(
      screen.queryByRole("button", {
        name: "Switch to point: event 498",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(expandBoundedActivity);
    expect(
      screen.getByRole("button", {
        name: "Switch to point: event 498",
      }),
    ).toBeInTheDocument();
  });
});
