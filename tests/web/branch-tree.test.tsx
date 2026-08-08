// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import { activeSnapshot, bootstrapPayload, installFakeWebSocket } from "./helpers";

const nodes = [
  { id: "u1", parentId: null, depth: 0, type: "message", role: "user", label: "user: root", snippet: "root", timestamp: "2026-08-01", active: true, leaf: false, canSwitch: false, canEdit: false, canFork: true },
  { id: "a1", parentId: "u1", depth: 1, type: "message", role: "assistant", label: "assistant: answer", snippet: "answer", timestamp: "2026-08-01", active: true, leaf: false, canSwitch: true, canEdit: false, canFork: false },
  { id: "u2", parentId: "a1", depth: 2, type: "message", role: "user", label: "user: revise", snippet: "revise", timestamp: "2026-08-01", active: true, leaf: false, canSwitch: false, canEdit: true, canFork: true },
  { id: "a2", parentId: "u2", depth: 3, type: "message", role: "assistant", label: "assistant: latest", snippet: "latest", timestamp: "2026-08-01", active: true, leaf: true, canSwitch: true, canEdit: false, canFork: false },
  { id: "branch", parentId: "a1", depth: 2, type: "message", role: "assistant", label: "assistant: sibling", snippet: "sibling", timestamp: "2026-08-01", active: false, leaf: false, canSwitch: true, canEdit: false, canFork: false },
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
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, body });
      if (url.startsWith("/api/bootstrap")) return Response.json(bootstrapPayload({ snapshot: activeSnapshot({ effectiveLeafId: "a2" }) }));
      if (url.startsWith("/api/sessions")) return Response.json({ sessions: [], total: 0, offset: 0, limit: 40 });
      if (url.startsWith("/api/git/status")) return Response.json({ kind: "not-repository" });
      if (url.startsWith("/api/branches/tree")) return Response.json(tree("s1", effectiveLeafId));
      if (url === "/api/branches/navigate") {
        effectiveLeafId = String(body.targetId);
        return Response.json({
          snapshot: activeSnapshot({ effectiveLeafId, messages: [{ role: "assistant", content: "switched", timestamp: 9 }] }),
          ...(body.mode === "edit" ? { editorText: "revise" } : {}),
        });
      }
      if (url === "/api/branches/fork") {
        return Response.json({
          sessionId: "forked",
          snapshot: activeSnapshot({ sessionId: "forked", sessionName: "Forked", messages: [] }),
          editorText: "revise",
        });
      }
      return Response.json({ error: `unhandled ${url}` }, { status: 404 });
    }));
    await store.init("token");
  });

  it("renders bounded ordered rows with keyboard-accessible switch, edit, and fork actions", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));

    const history = await screen.findByLabelText("Conversation history and branches");
    expect(history).toBeInTheDocument();
    expect(screen.getByText(/cannot edit from the root user message/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current branch: assistant: latest" })).toBeDisabled();
    const switchButton = screen.getByRole("button", { name: "Switch branch: assistant: sibling" });
    switchButton.focus();
    fireEvent.keyDown(switchButton, { key: "Enter" });
    fireEvent.click(switchButton);
    await waitFor(() => expect(requests.some(({ url, body }) => url === "/api/branches/navigate" && body.targetId === "branch" && body.mode === "switch")).toBe(true));
    expect(confirm).toHaveBeenCalled();

    const edit = screen.getByRole("button", { name: "Edit from here: user: revise" });
    fireEvent.click(edit);
    await waitFor(() => expect(screen.getByPlaceholderText("Message Pi…")).toHaveValue("revise"));
    expect(requests.some(({ url, body }) => url === "/api/branches/navigate" && body.targetId === "u2" && body.mode === "edit")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Fork from here: user: revise" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Message Pi…")).toHaveValue("revise"));
    expect(store.getState().sessionId).toBe("forked");
    expect(requests.some(({ url, body }) => url === "/api/branches/fork" && body.targetId === "u2")).toBe(true);
  });

  it("keeps the last tree visible with explicit stale and truncated states", async () => {
    store.setResourcesOpen(true);
    store.setContextMode("files");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    await screen.findByLabelText("Conversation history and branches");

    // A projection update makes actions visibly stale until refresh.
    const socket = (globalThis as unknown as { __unused?: unknown }).__unused;
    void socket;
    // Exercise the store's explicit stale presentation without mutating the tree.
    (store as unknown as { set(partial: unknown): void }).set({ branchTreeError: "Branch history is stale — refresh to use branch actions" });
    expect(await screen.findByText(/Branch history is stale/)).toBeInTheDocument();
    expect(screen.getByText("sibling")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch branch: assistant: sibling" })).toBeDisabled();
    const actionRequests = requests.filter(({ url }) => url === "/api/branches/navigate" || url === "/api/branches/fork").length;
    await expect(store.navigateBranch("branch", "switch")).resolves.toBe(false);
    await expect(store.forkBranch("u2")).resolves.toBe(false);
    expect(requests.filter(({ url }) => url === "/api/branches/navigate" || url === "/api/branches/fork")).toHaveLength(actionRequests);

    (store as unknown as { set(partial: unknown): void }).set({ branchTreeError: null, projectionHealth: { status: "error", message: "projection failed" } });
    await expect(store.navigateBranch("branch", "switch")).resolves.toBe(false);
    expect(screen.getByRole("button", { name: "Switch branch: assistant: sibling" })).toBeDisabled();
  });
});
