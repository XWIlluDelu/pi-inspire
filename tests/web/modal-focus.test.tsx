// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Settings } from "../../src/components/Settings";
import { useModalFocus } from "../../src/use-modal-focus";

describe("modal focus ownership", () => {
  it("cycles Tab within a modal and restores its opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const user = userEvent.setup();
    const view = render(<Settings onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const first = screen.getByRole("button", { name: "Close settings" });
    const last = screen.getByRole("link", { name: "Pi Coding Agent" });
    expect(document.activeElement).toBe(first);

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);

    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    view.unmount();
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("restores the control that opened a top modal", async () => {
    function NestedDialogs() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      const outerRef = useModalFocus<HTMLDivElement>(outerOpen);
      const innerRef = useModalFocus<HTMLDivElement>(innerOpen);
      return (
        <>
          <button type="button" onClick={() => setOuterOpen(true)}>
            Open outer
          </button>
          {outerOpen ? (
            <div
              ref={outerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Outer"
              tabIndex={-1}
            >
              <button type="button" onClick={() => setInnerOpen(true)}>
                Open inner
              </button>
            </div>
          ) : null}
          {innerOpen ? (
            <div
              ref={innerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Inner"
              tabIndex={-1}
            >
              <button type="button" onClick={() => setInnerOpen(false)}>
                Close inner
              </button>
            </div>
          ) : null}
        </>
      );
    }

    render(<NestedDialogs />);
    const outerOpener = screen.getByRole("button", { name: "Open outer" });
    outerOpener.focus();
    fireEvent.click(outerOpener);
    const innerOpener = screen.getByRole("button", { name: "Open inner" });
    fireEvent.click(innerOpener);
    fireEvent.click(screen.getByRole("button", { name: "Close inner" }));
    await Promise.resolve();
    expect(document.activeElement).toBe(innerOpener);
  });

  it("restores the original opener when an underlying modal closes first", async () => {
    function NestedDialogs() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      const outerRef = useModalFocus<HTMLDivElement>(outerOpen);
      const innerRef = useModalFocus<HTMLDivElement>(innerOpen);
      return (
        <>
          <button type="button" onClick={() => setOuterOpen(true)}>
            Open outer
          </button>
          {outerOpen ? (
            <div
              ref={outerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Outer"
              tabIndex={-1}
            >
              <button type="button" onClick={() => setInnerOpen(true)}>
                Open inner
              </button>
            </div>
          ) : null}
          {innerOpen ? (
            <div
              ref={innerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Inner"
              tabIndex={-1}
            >
              <button type="button" onClick={() => setOuterOpen(false)}>
                Close outer first
              </button>
              <button type="button" onClick={() => setInnerOpen(false)}>
                Close inner
              </button>
            </div>
          ) : null}
        </>
      );
    }

    render(<NestedDialogs />);
    const opener = screen.getByRole("button", { name: "Open outer" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Open inner" }));
    fireEvent.click(screen.getByRole("button", { name: "Close outer first" }));
    expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull();
    expect(
      screen
        .getByRole("dialog", { name: "Inner" })
        .contains(document.activeElement),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close inner" }));
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
  });

  it("activates when a permanently mounted dialog appears later", () => {
    function DelayedDialog() {
      const [open, setOpen] = useState(false);
      const ref = useModalFocus<HTMLDivElement>(open);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open ? (
            <div
              ref={ref}
              role="dialog"
              aria-modal="true"
              aria-label="Delayed"
              tabIndex={-1}
            >
              <button type="button">Inside</button>
            </div>
          ) : null}
        </>
      );
    }

    render(<DelayedDialog />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Inside" }),
    );
  });
});
