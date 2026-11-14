// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
import { SessionActionsMenu } from "../../src/components/SessionActionsMenu";
import { SessionActionsSettings } from "../../src/components/SessionActionsSettings";
import { store } from "../../src/store";
import { deferred } from "./helpers";

function Harness({
  onCopyError = vi.fn(),
  readOnly = false,
}: {
  onCopyError?: (message: string) => void;
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
          onSwitchBranch={vi.fn()}
          onExport={vi.fn()}
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
  const original = edit();
  fireEvent.change(original, { target: { value: "  Committed title  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save session name" }));
  expect(rename).toHaveBeenCalledExactlyOnceWith("s1", "Committed title");
  select("s2", "Other session");
  await act(async () => receipt.resolve(true));
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
});
