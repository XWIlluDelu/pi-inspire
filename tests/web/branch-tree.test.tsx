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
  readHistoryReading,
  workbenchSessionKey,
} from "../../src/workbench-session";
import { sessionPage } from "./fixtures/session-catalog";
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
  canEdit: role === "user",
  canFork: role === "user",
});
const nodes = [
  point("u1", null, "user", "Root question"),
  point("a1", "u1", "assistant", "Earlier answer"),
  point("u2", "a1", "user", "Revised question"),
  point("a2", "u2", "assistant", "Latest answer", true),
];

let fixture: {
  effective: string | null;
  navigationLeased?: boolean;
  revision: number;
  skip: boolean;
  cancelled: boolean;
  activity?: "model" | "shell";
  searchGate?: Promise<void>;
  navigateGate?: Promise<void>;
  outline?: BranchTreeNode[];
};
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
function tree(query = ""): BranchTreeResponse {
  const url = new URL(query || "/", "http://fixture");
  const search = url.searchParams.get("query");
  const selected = search
    ? nodes.filter((node) => node.snippet.includes(search))
    : (fixture.outline ?? nodes);
  return {
    sessionId: "s1",
    revision: fixture.revision,
    incarnation: "history-fixture",
    durableLeafId: "a2",
    effectiveLeafId: fixture.effective,
    activePath: nodes.filter((node) => node.active).map((node) => node.id),
    nodes: selected,
    truncated: false,
    nextBefore: null,
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
                navigationLeased:
                  fixture.navigationLeased ?? fixture.effective !== "a2",
              }),
              runState: fixture.activity === "model" ? "running" : "idle",
              bashRunning: fixture.activity === "shell",
            },
          }),
        );
      if (url.startsWith("/api/sessions"))
        return Response.json(sessionPage([], 0));
      if (url.startsWith("/api/branches/tree")) {
        if (new URL(url, "http://fixture").searchParams.has("query"))
          await fixture.searchGate;
        return Response.json(tree(url));
      }
      if (url.startsWith("/api/branches/entry")) {
        const id = new URL(url, "http://fixture").searchParams.get("targetId");
        const node = nodes.find((node) => node.id === id);
        if (!node)
          return Response.json(
            { error: "History entry no longer exists" },
            { status: 404 },
          );
        return Response.json({
          sessionId: "s1",
          revision: fixture.revision,
          node,
          text: node.snippet,
          nextOffset: null,
          totalChars: node.snippet.length,
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
            navigationLeased: fixture.effective !== "a2",
            transcriptPage: {
              revision: fixture.revision,
              viewId: fixture.cancelled ? "view-1" : "changed-view",
              effectiveLeafId: fixture.effective,
              messages: [],
            },
          }),
          ...(fixture.cancelled
            ? { cancelled: true }
            : node.canEdit
              ? { editorText: node.snippet }
              : {}),
        });
      }
      return Response.json(
        { error: `Unhandled fixture request: ${url}` },
        { status: 404 },
      );
    }),
  );
  await store.init();
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
  await screen.findByText("Earlier answer", {
    selector: ".history-detail__body p",
  });
}

describe("read-only History inspection", () => {
  it("offers independent copies while keeping an externally owned source read-only", async () => {
    (store as unknown as { set(value: unknown): void }).set({
      readOnlyReason: "external-active",
    });
    render(<BranchTree />);
    fireEvent.click(
      within(history()).getByRole("button", { name: "Root question" }),
    );
    const fork = await screen.findByRole("button", {
      name: "Fork to new session",
    });
    await waitFor(() => expect(fork).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Clone through here" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Edit in this session" }),
    ).toBeDisabled();
  });

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

  it("retires a pending search when cleared without letting it retire the next read", async () => {
    const older = deferred<void>();
    fixture.searchGate = older.promise;
    render(<BranchTree />);
    const search = screen.getByRole("searchbox", { name: "Find in history" });
    fireEvent.change(search, { target: { value: "Earlier" } });
    await screen.findByLabelText("Searching history");
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(fireEvent.keyDown(search, { key: "Escape", ...ime })).toBe(true);
      expect(search).toHaveValue("Earlier");
    }
    const clear = screen.getByRole("button", { name: "Clear history search" });
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    await waitFor(() =>
      expect(history()).not.toHaveAttribute("aria-busy", "true"),
    );
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
});

describe("History reading restoration", () => {
  const readingKey = (sessionId = "s1") =>
    workbenchSessionKey(sessionId, "/history-fixture");

  it("does not carry selection or query across distinct reading-state owners", async () => {
    const first = readHistoryReading(readingKey());
    first.query = "Root";
    first.selectedEntryId = "u1";
    const second = readHistoryReading(readingKey("s2"));
    second.query = "Revised";
    const mounted = render(<BranchTree readingState={first} />);
    await screen.findByRole("button", { name: "Edit in this session" });

    mounted.rerender(<BranchTree readingState={second} />);
    expect(
      await screen.findByRole("searchbox", { name: "Find in history" }),
    ).toHaveValue("Revised");
    expect(
      screen.queryByRole("button", { name: "Back to history" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Your input Revised question",
      }),
    );
    await screen.findByRole("button", { name: "Edit in this session" });
    expect(second.selectedEntryId).toBe("u2");
    expect(first.selectedEntryId).toBe("u1");

    mounted.rerender(<BranchTree readingState={first} />);
    await waitFor(() =>
      expect(
        history().querySelector(".history-detail__body"),
      ).toHaveTextContent("Root question"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(
      screen.getByRole("searchbox", { name: "Find in history" }),
    ).toHaveValue("Root");
    expect(second.query).toBe("Revised");
    expect(second.selectedEntryId).toBe("u2");
  });

  it("recovers invalid saved metadata and persists only reading position", () => {
    const storageKey = `${readingKey()}:history`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        query: 10,
        expanded: ["one", "", "one", 5, "two"],
        selectedEntryId: "",
        routeLeafId: [],
        outline: { top: -1, left: 0 },
        detail: { top: 300, left: null },
        content: "transcript body",
      }),
    );
    const reading = readHistoryReading(readingKey());
    const metadata = {
      query: "",
      expanded: ["one", "two"],
      selectedEntryId: null,
      routeLeafId: null,
      outline: { top: 0, left: 0 },
      detail: { top: 0, left: 0 },
    };
    expect(reading).toMatchObject({ ...metadata, restored: false });
    reading.save?.();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(metadata);
    expect(readHistoryReading(readingKey()).restored).toBe(true);
    for (const other of [
      readingKey("s2"),
      workbenchSessionKey("s1", "/other-workspace"),
      null,
    ]) {
      expect(readHistoryReading(other)).toMatchObject({
        restored: false,
        selectedEntryId: null,
      });
    }
  });

  it("keeps History reading position in memory when storage is refused", () => {
    const unavailable = () => {
      throw new DOMException("Storage unavailable", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(unavailable);
    const reading = readHistoryReading(readingKey());
    reading.selectedEntryId = "entry";
    reading.save?.();
    expect(reading).toMatchObject({ restored: true, selectedEntryId: "entry" });
  });
});

describe("explicit History actions", () => {
  it.each(["model", "shell"] as const)(
    "allows inspection and independent copying during %s work, but not same-session continuation",
    async (activity) => {
      fixture.activity = activity;
      await store.init();
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
        screen.getByText("Wait for the current task to finish."),
      ).toBeVisible();
    },
  );

  it("preserves a newer draft revision even when its text returns to the confirmed draft", async () => {
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
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "newer draft" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "confirmed draft" },
    });
    await act(async () => summary.resolve());
    await waitFor(() => expect(store.getState().branchActionId).toBeNull());
    expect(store.getState().transcriptEffectiveLeafId).toBeNull();
    expect(screen.getByLabelText("Message")).toHaveValue("confirmed draft");
    expect(sessionDraft("s1")).toBe("confirmed draft");
  });

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

  it("shows restore progress even when continuing before the first message", async () => {
    fixture.effective = null;
    await store.init();
    await store.loadBranchTree();
    const pending = deferred<void>();
    fixture.navigateGate = pending.promise;
    render(<EarlierBranchBanner />);
    const restore = screen.getByRole("button", {
      name: "Restore saved position",
    });
    try {
      fireEvent.click(restore);
      await waitFor(() => expect(restore).toHaveAttribute("aria-busy", "true"));
      expect(restore).toBeDisabled();
    } finally {
      await act(async () => pending.resolve());
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Earlier continuation" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the notice hidden for an attached Pi with a different observed leaf", async () => {
    fixture.effective = "a1";
    fixture.navigationLeased = false;
    await store.init();
    render(<EarlierBranchBanner />);
    expect(
      screen.queryByRole("region", { name: "Earlier continuation" }),
    ).not.toBeInTheDocument();
  });
});
