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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import {
  SESSION_ACTION_IDS,
  type SessionActionId,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { AppTopbar, sessionHeading } from "../../src/components/AppTopbar";
import { ExportDialog } from "../../src/components/ExportDialog";
import { SessionActionsMenu } from "../../src/components/SessionActionsMenu";
import { SessionActionsSettings } from "../../src/components/SessionActionsSettings";
import { store } from "../../src/store";
import { deferred } from "./helpers";

function Harness({
  onCopyError = vi.fn(),
  onExport = vi.fn(),
  onSwitchBranch = vi.fn(),
  readOnly = false,
}: {
  onCopyError?: (message: string) => void;
  onExport?: () => void;
  onSwitchBranch?: () => void;
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
          onCopyError={onCopyError}
          renameDisabled={readOnly}
          cloneDisabled={readOnly}
          onRename={vi.fn()}
          onClone={vi.fn()}
          onSwitchBranch={onSwitchBranch}
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
  const cancelled = edit();
  fireEvent.change(cancelled, { target: { value: "Discard this edit" } });
  fireEvent.keyDown(cancelled, { key: "Escape" });
  expect(rename).not.toHaveBeenCalled();

  const original = edit();
  fireEvent.change(original, { target: { value: "  Committed title  " } });
  const save = screen.getByRole("button", { name: "Save session name" });
  fireEvent.click(save);
  expect(rename).toHaveBeenCalledExactlyOnceWith("s1", "Committed title");
  fireEvent.change(original, { target: { value: "A newer draft" } });
  await act(async () => receipt.resolve(true));
  expect(original).toHaveValue("A newer draft");

  select("s2", "Other session");
  expect(original).not.toBeInTheDocument();
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

  it("opens the shared History destination from the title menu", async () => {
    const onSwitchBranch = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSwitchBranch={onSwitchBranch} />);
    await user.click(screen.getByRole("button", { name: "Session title" }));
    await user.click(screen.getByRole("menuitem", { name: "Switch branch…" }));
    expect(onSwitchBranch).toHaveBeenCalledOnce();
  });

  it("uses the settings order for menu keyboard navigation and returns focus", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<Harness onExport={onExport} />);
    const up = screen.getByRole("button", { name: "Move Export session… up" });
    up.focus();
    await user.keyboard("{Enter}");
    expect(up).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("position 4 of 5");
    const title = screen.getByRole("button", { name: "Session title" });
    await user.click(title);
    const menu = within(screen.getByRole("menu", { name: "Session actions" }));
    expect(menu.getAllByRole("menuitem").at(3)).toHaveTextContent(
      "Export session…",
    );
    await user.keyboard("{End}{ArrowUp}{Enter}");
    expect(onExport).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(title).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps focus on the moved action at the order boundary", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const up = screen.getByRole("button", { name: "Move Copy session ID up" });
    const down = screen.getByRole("button", {
      name: "Move Copy session ID down",
    });
    await user.click(up);
    const rows = within(
      screen.getByRole("list", { name: "Session action order" }),
    ).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Copy session ID");
    expect(up).toBeDisabled();
    expect(down).toHaveFocus();
    await user.click(down);
    expect(down).toHaveFocus();
    expect(
      within(
        screen.getByRole("list", { name: "Session action order" }),
      ).getAllByRole("listitem")[1],
    ).toHaveTextContent("Copy session ID");
  });

  it("retains the selected format on failure and downloads for the captured session on retry", async () => {
    const exportSession = vi
      .spyOn(store, "exportSession")
      .mockRejectedValueOnce(new Error("Unable to read this session"))
      .mockResolvedValueOnce();
    const onClose = vi.fn();
    const view = render(
      <ExportDialog sessionId="s1" active onClose={onClose} />,
    );
    expect(
      screen.getByRole("radio", { name: "HTML Whole session" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("radio", { name: "JSONL Current branch" }),
    );
    view.rerender(
      <ExportDialog sessionId="s1" active={false} onClose={onClose} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ExportDialog sessionId="s1" active onClose={onClose} />);
    expect(
      screen.getByRole("radio", { name: "JSONL Current branch" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to read this session",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("radio", { name: "JSONL Current branch" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(exportSession.mock.calls).toEqual([
      ["s1", "jsonl"],
      ["s1", "jsonl"],
    ]);
  });
});
