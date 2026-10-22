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
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ACTION_IDS,
  type SessionActionId,
} from "../../shared/contracts";
import { SessionActionsMenu } from "../../src/components/SessionActionsMenu";
import { SessionActionsSettings } from "../../src/components/SessionActionsSettings";

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
          terminalDisabled={readOnly}
          onRename={vi.fn()}
          onClone={vi.fn()}
          onTerminal={vi.fn()}
          onExport={onExport}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe("Session actions", () => {
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

  it("offers keyboard reordering from the menu handle using the same settings order", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Session title" }));
    const handle = screen.getByRole("menuitem", {
      name: "Reorder Use in terminal…",
    });
    handle.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(handle).toHaveFocus();
    expect(
      within(screen.getByRole("list", { name: "Session action order" }))
        .getAllByRole("listitem")
        .at(-1),
    ).toHaveTextContent("Use in terminal…");
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
    await user.keyboard("{Enter}");
    expect(exportHandle).toHaveFocus();
    expect(actionLabels()).toEqual([
      "Rename session",
      "Copy session ID",
      "Clone current branch",
      "Export session…",
      "Use in terminal…",
    ]);
    await user.click(screen.getByRole("button", { name: "Session title" }));
    expect(
      screen.getByRole("menuitem", { name: "Export session…" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Use in terminal…" }),
    ).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "More actions" }));
    const terminal = screen.getByRole("menuitem", { name: "Use in terminal…" });
    expect(terminal).toBeEnabled();
    fireEvent.keyDown(terminal, { key: "Escape" });
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
  });
});
