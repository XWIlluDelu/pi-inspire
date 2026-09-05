// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { dismissTerminalMenu } from "../../src/terminal-menus";
import { useModalFocus } from "../../src/use-modal-focus";

function Menu() {
  return (
    <details open data-terminal-menu>
      <summary>Terminal actions</summary>
      <button type="button">Rename terminal</button>
    </details>
  );
}

function MenuModal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose(): void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "menu-modal", (event) => {
    if (!dismissTerminalMenu(ref.current, event.target)) onClose();
  });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Context">
      {children}
    </div>
  );
}

function TopModal({ onClose }: { onClose(): void }) {
  const ref = useModalFocus<HTMLDivElement>(true, "top-modal", onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Confirmation">
      <button type="button">Confirm</button>
    </div>
  );
}

describe("terminal menu dismissal", () => {
  it("dismisses only a marked menu inside its owner and restores the summary", () => {
    const view = render(
      <div>
        <Menu />
        <details open>
          <summary>Other disclosure</summary>
          <button type="button">Other content</button>
        </details>
      </div>,
    );
    const target = screen.getByRole("button", { name: "Rename terminal" });
    target.focus();
    expect(dismissTerminalMenu(document.createElement("div"), target)).toBe(
      false,
    );
    expect(
      dismissTerminalMenu(
        view.container,
        screen.getByRole("button", { name: "Other content" }),
      ),
    ).toBe(false);
    expect(dismissTerminalMenu(view.container, target)).toBe(true);
    expect(target.closest("details")).not.toHaveAttribute("open");
    expect(document.activeElement).toBe(screen.getByText("Terminal actions"));
    expect(dismissTerminalMenu(view.container, target)).toBe(false);
  });

  it("lets the modal capture owner dismiss a menu before closing the drawer or leaking Escape", () => {
    const close = vi.fn();
    render(
      <MenuModal onClose={close}>
        <Menu />
      </MenuModal>,
    );
    const shellKey = vi.fn();
    window.addEventListener("keydown", shellKey);
    try {
      const target = screen.getByRole("button", { name: "Rename terminal" });
      target.focus();
      fireEvent.keyDown(target, { key: "Escape" });
      expect(target.closest("details")).not.toHaveAttribute("open");
      const summary = screen.getByText("Terminal actions");
      expect(document.activeElement).toBe(summary);
      expect(close).not.toHaveBeenCalled();
      expect(shellKey).not.toHaveBeenCalled();
      fireEvent.keyDown(summary, { key: "Escape" });
      expect(close).toHaveBeenCalledTimes(1);
      expect(shellKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", shellKey);
    }
  });

  it("does not dismiss an underlying terminal menu through a newer modal", () => {
    const closeOuter = vi.fn();
    const closeTop = vi.fn();
    render(
      <>
        <MenuModal onClose={closeOuter}>
          <Menu />
        </MenuModal>
        <TopModal onClose={closeTop} />
      </>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Confirm" }), {
      key: "Escape",
    });
    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
    expect(
      screen.getByText("Terminal actions").closest("details"),
    ).toHaveAttribute("open");
  });

  it("preserves the explicit modal opt-out for host recovery Escape", () => {
    function RecoveryModal() {
      const ref = useModalFocus<HTMLDivElement>(true, "recovery", () => false);
      return (
        <div ref={ref}>
          <button type="button">Recover</button>
        </div>
      );
    }
    render(<RecoveryModal />);
    const recovery = vi.fn();
    window.addEventListener("keydown", recovery);
    try {
      fireEvent.keyDown(screen.getByRole("button", { name: "Recover" }), {
        key: "Escape",
      });
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(recovery.mock.calls[0]![0].defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", recovery);
    }
  });
});
