// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import {
  SESSION_ACTION_IDS,
  type SessionActionId,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { AppTopbar, sessionHeading } from "../../src/components/AppTopbar";
import { SessionActionsMenu } from "../../src/components/SessionActionsMenu";
import { SessionActionsSettings } from "../../src/components/SessionActionsSettings";
import { store } from "../../src/store";
import { deferred } from "./helpers";

function Harness({
  onCopyError = vi.fn(),
  onExport = vi.fn(),
  readOnly = false,
}: {
  onCopyError?: (message: string) => void;
  onExport?: () => void;
  readOnly?: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<SessionActionId[]>([
    ...SESSION_ACTION_IDS,
  ]);
  return (
    <>
      <SessionActionsSettings order={order} onChange={setOrder} />
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>
        Session title
      </button>
      {open ? (
        <SessionActionsMenu
          anchorRef={anchorRef}
          sessionId="01a163f4-8e43-71df-9bd6-71efa60bd123"
          actionOrder={order}
          onOrderChange={setOrder}
          onCopyError={onCopyError}
          renameDisabled={readOnly}
          cloneDisabled={readOnly}
          onRename={vi.fn()}
          onClone={vi.fn()}
          onExport={onExport}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("Session headings", () => {
  it.each(["Review this report", ""])(
    "uses the same file-aware title before and after catalog refresh for %j",
    (text) => {
      const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
      const messages = [
        {
          role: "user" as const,
          content: text ? `${text}\n\n${trailer}` : trailer,
        },
        { role: "user" as const, content: "A later question" },
      ];
      const title = text || "report.csv";
      expect(sessionHeading("", undefined, messages, true)).toBe(title);
      expect(sessionHeading("", title, messages, false)).toBe(title);
      expect(sessionHeading("Named report", title, messages, true)).toBe(
        "Named report",
      );
      expect(sessionHeading("", undefined, messages, false)).toBe(
        "New session",
      );
    },
  );
});

function renderTopbar() {
  let state = {
    ...createInitialAppState(),
    sessionId: "s1",
    sessionName: "Original title",
    cwd: "/workspace/report",
    gitStatus: { kind: "not-repository" as const },
  };
  vi.spyOn(store, "getState").mockImplementation(() => state);
  const listeners = new Set<() => void>();
  vi.spyOn(store, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const noop = () => {};
  render(
    <AppTopbar
      narrowViewport={false}
      mobileNavOpen={false}
      settingsOpen={false}
      onToggleNavigation={noop}
      onOpenCommandPalette={noop}
      onExportSession={noop}
      onToggleSettings={noop}
      onToggleResources={noop}
    />,
  );
  return (sessionId: string, sessionName: string) =>
    act(() => {
      state = { ...state, sessionId, sessionName };
      for (const publish of listeners) publish();
    });
}

it("keeps rename writes owned by the active editor and session", async () => {
  const select = renderTopbar();
  const receipt = deferred<boolean>();
  const rename = vi
    .spyOn(store, "renameSession")
    .mockReturnValue(receipt.promise);
  const edit = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Session actions:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename session" }));
    return screen.getByRole("textbox", { name: "Session name" });
  };
  for (const value of ["Original title", "   "]) {
    const input = edit();
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input, { relatedTarget: null });
    expect(input).not.toBeInTheDocument();
  }
  const cancelled = edit();
  fireEvent.change(cancelled, { target: { value: "Discard this edit" } });
  fireEvent.keyDown(cancelled, { key: "Escape" });
  expect(rename).not.toHaveBeenCalled();

  const original = edit();
  fireEvent.change(original, { target: { value: "  Committed title  " } });
  const save = screen.getByRole("button", { name: "Save session name" });
  fireEvent.blur(original, { relatedTarget: save });
  expect(rename).not.toHaveBeenCalled();
  fireEvent.click(save);
  expect(rename).toHaveBeenCalledExactlyOnceWith("s1", "Committed title");
  fireEvent.keyDown(original, { key: "Escape" });
  const reopened = edit();
  await act(async () => receipt.resolve(true));
  expect(reopened).toBeInTheDocument();

  select("s2", "Other session");
  expect(reopened).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Other session" })).toBeVisible();
});

it.each(["resolve", "reject"] as const)(
  "retires project path copy %s when the session owner changes",
  async (outcome) => {
    renderTopbar();
    const write = deferred<void>();
    userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValue(write.promise);
    let owned = true;
    vi.spyOn(store, "copyOwnership").mockReturnValue(() => owned);
    const report = vi
      .spyOn(store, "reportCopyError")
      .mockImplementation(() => {});
    const path = screen.getByRole("button", { name: "Copy project path" });
    fireEvent.click(path);
    expect(writeText).toHaveBeenCalledWith("/workspace/report");
    owned = false;
    await act(async () => {
      if (outcome === "resolve") write.resolve();
      else write.reject(new Error("Retired clipboard result"));
    });
    expect(path).not.toHaveAttribute("title", "Copied");
    expect(report).not.toHaveBeenCalled();
  },
);

describe("Session actions", () => {
  beforeEach(() => {
    vi.spyOn(store, "branchLeaves").mockResolvedValue({ total: 1, leaves: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("copies the complete ID in read-only sessions and reports clipboard failure before retry", async () => {
    const user = userEvent.setup();
    let completeCopy!: () => void;
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard permission denied"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeCopy = resolve;
          }),
      );
    const onCopyError = vi.fn();
    render(<Harness readOnly onCopyError={onCopyError} />);
    await user.click(screen.getByRole("button", { name: "Session title" }));
    const copy = screen.getByRole("menuitem", { name: "Copy session ID" });
    expect(copy).toHaveFocus();
    expect(
      screen.getByRole("menuitem", { name: "Rename session" }),
    ).toBeDisabled();
    await user.click(copy);
    expect(onCopyError).toHaveBeenCalledWith("Clipboard permission denied");
    expect(screen.queryByText("ID copied")).toBeNull();
    await user.click(copy);
    expect(clipboard).toHaveBeenLastCalledWith(
      "01a163f4-8e43-71df-9bd6-71efa60bd123",
    );
    // Native disabled buttons lose focus in browsers during clipboard writes.
    expect(copy).not.toBeDisabled();
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(clipboard).toHaveBeenCalledTimes(2);
    await act(async () => completeCopy());
    expect(
      await screen.findByRole("menuitem", { name: "ID copied" }),
    ).toHaveFocus();
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeVisible();
  });

  it("switches branches from the title menu and disables the choice with one branch", async () => {
    const leaves = vi.spyOn(store, "branchLeaves").mockResolvedValue({
      total: 2,
      leaves: [
        {
          id: "newer",
          excerpt: "Try the other approach",
          updatedAt: new Date().toISOString(),
          isDefault: true,
          isCurrent: false,
        },
        {
          id: "viewed",
          excerpt: "Original question",
          updatedAt: new Date().toISOString(),
          isDefault: false,
          isCurrent: true,
        },
      ],
    });
    const select = vi.spyOn(store, "selectBranch").mockResolvedValue(true);
    try {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "Session title" }));
      expect(
        screen.queryByRole("menuitem", { name: "Switch branch…" }),
      ).toBeNull();
      await user.click(screen.getByRole("menuitem", { name: "More actions" }));
      const open = screen.getByRole("menuitem", { name: "Switch branch…" });
      await waitFor(() => expect(open).toBeEnabled());
      await user.click(open);
      const current = screen.getByRole("menuitemradio", {
        name: /Original question/,
      });
      expect(current).toHaveAttribute("aria-checked", "true");
      const other = screen.getByRole("menuitemradio", {
        name: /Try the other approach.*Default/,
      });
      expect(other).toHaveFocus();
      await user.click(
        screen.getByRole("menuitem", { name: "Back to actions" }),
      );
      expect(
        screen.getByRole("menuitem", { name: "Switch branch…" }),
      ).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(
        screen.getByRole("menuitemradio", {
          name: /Try the other approach.*Default/,
        }),
      ).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(select).toHaveBeenCalledWith(
        "01a163f4-8e43-71df-9bd6-71efa60bd123",
        "newer",
      );
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      leaves.mockResolvedValue({ total: 1, leaves: [] });
      await user.click(screen.getByRole("button", { name: "Session title" }));
      await waitFor(() => expect(leaves).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole("menuitem", { name: "More actions" }));
      expect(
        screen.getByRole("menuitem", { name: "Switch branch…" }),
      ).toBeDisabled();
    } finally {
      leaves.mockRestore();
      select.mockRestore();
    }
  });

  it("retries unavailable branches and refreshes changes to the same session", async () => {
    const sessionId = "01a163f4-8e43-71df-9bd6-71efa60bd123";
    const previous = store.getState();
    const set = (patch: Partial<typeof previous>) =>
      act(() => (store as unknown as { set(value: unknown): void }).set(patch));
    const leaves = vi
      .spyOn(store, "branchLeaves")
      .mockRejectedValueOnce(new Error("Branch service unavailable"))
      .mockResolvedValueOnce({ total: 1, leaves: [] })
      .mockResolvedValue({
        total: 2,
        leaves: [
          {
            id: "other",
            excerpt: "Another branch",
            updatedAt: "2026-08-01T12:00:00Z",
            isCurrent: false,
            isDefault: true,
          },
        ],
      });
    try {
      set({ sessionId, transcriptRevision: 1 });
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "Session title" }));
      await user.click(screen.getByRole("menuitem", { name: "More actions" }));
      const switchBranch = screen.getByRole("menuitem", {
        name: "Switch branch…",
      });
      await waitFor(() => expect(switchBranch).toBeEnabled());
      await user.click(switchBranch);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load branches",
      );
      expect(
        screen.queryByText("This session has no other branch."),
      ).toBeNull();
      await user.click(screen.getByRole("menuitem", { name: "Retry" }));
      expect(
        await screen.findByText("This session has no other branch."),
      ).toBeVisible();
      set({ transcriptRevision: 2 });
      expect(
        await screen.findByRole("menuitemradio", { name: /Another branch/ }),
      ).toBeVisible();
      expect(leaves).toHaveBeenCalledTimes(3);
    } finally {
      leaves.mockRestore();
      set({
        sessionId: previous.sessionId,
        transcriptRevision: previous.transcriptRevision,
      });
    }
  });

  it("reveals overflow for keyboard use and resets it on reopening", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<Harness onExport={onExport} />);
    const title = screen.getByRole("button", { name: "Session title" });
    await user.click(title);
    expect(
      screen.queryByRole("menuitem", { name: "Export session…" }),
    ).toBeNull();
    await user.keyboard("{End}{Enter}");
    const more = screen.getByRole("menuitem", { name: "Fewer actions" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitem", { name: "Export session…" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onExport).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(title).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(title);
    expect(
      screen.queryByRole("menuitem", { name: "Export session…" }),
    ).toBeNull();
  });

  it("reorders Switch branch from its menu handle even when switching is unavailable", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Session title" }));
    await user.click(screen.getByRole("menuitem", { name: "More actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Switch branch…" }),
    ).toBeDisabled();
    const handle = screen.getByRole("menuitem", {
      name: "Reorder Switch branch…",
    });
    handle.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(handle).toHaveFocus();
    expect(
      within(screen.getByRole("list", { name: "Session action order" }))
        .getAllByRole("listitem")
        .at(2),
    ).toHaveTextContent("Switch branch…");
    expect(
      screen.getByRole("menuitem", { name: "Export session…" }),
    ).toBeVisible();
  });

  it("moves actions across the disclosure boundary without losing other actions", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const list = screen.getByRole("list", { name: "Session action order" });
    const actionLabels = () =>
      Array.from(
        list.querySelectorAll(".session-action-order__label"),
        (label) => label.textContent,
      );
    const exportHandle = screen.getByRole("button", {
      name: "Reorder Export session…",
    });
    exportHandle.focus();
    await user.keyboard("{Enter}");
    const moveUp = screen.getByRole("menuitem", {
      name: "Move Export session… up",
    });
    expect(moveUp).toHaveFocus();
    expect(
      within(
        screen.getByRole("menu", { name: "Move options for Export session…" }),
      )
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Move Export session… up", "Move Export session… down"]);
    expect(
      screen.getByRole("menuitem", { name: "Move Export session… down" }),
    ).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(exportHandle).toHaveFocus();
    expect(actionLabels()).toEqual([
      "Rename session",
      "Copy session ID",
      "Clone current branch",
      "Export session…",
      "Switch branch…",
    ]);
    fireEvent.click(exportHandle);
    await user.click(
      screen.getByRole("menuitem", { name: "Move Export session… up" }),
    );
    await user.click(screen.getByRole("button", { name: "Session title" }));
    expect(
      screen.getByRole("menuitem", { name: "Export session…" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Switch branch…" }),
    ).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "More actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Switch branch…" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const copyHandle = screen.getByRole("button", {
      name: "Reorder Copy session ID",
    });
    fireEvent.click(copyHandle);
    const copyUp = screen.getByRole("menuitem", {
      name: "Move Copy session ID up",
    });
    expect(copyUp).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(actionLabels()[0]).toBe("Copy session ID");
    fireEvent.click(copyHandle);
    expect(
      screen.getByRole("menuitem", { name: "Move Copy session ID up" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("menuitem", { name: "Move Copy session ID down" }),
    );
    expect(actionLabels()[1]).toBe("Copy session ID");
    expect(copyHandle).toHaveFocus();
  });
});
