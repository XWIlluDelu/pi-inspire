// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../src/components/SettingsDialog";
import {
  recoverModalFocus,
  useModalDepth,
  useModalFocus,
} from "../../src/use-modal-focus";

describe("modal focus ownership", () => {
  it("reports only visible backdrops while suspended dialogs retain ownership", () => {
    function Depth() {
      return <output aria-label="Backdrop depth">{useModalDepth()}</output>;
    }
    const content = (suspended: boolean) => (
      <StrictMode>
        <Depth />
        <SettingsDialog suspended={suspended} onClose={() => undefined}>
          <button type="button">Setting</button>
        </SettingsDialog>
      </StrictMode>
    );
    const view = render(content(false));
    expect(screen.getByLabelText("Backdrop depth")).toHaveTextContent("1");
    view.rerender(content(true));
    expect(screen.getByLabelText("Backdrop depth")).toHaveTextContent("0");
    view.rerender(content(false));
    expect(screen.getByLabelText("Backdrop depth")).toHaveTextContent("1");
    view.rerender(<Depth />);
    expect(screen.getByLabelText("Backdrop depth")).toHaveTextContent("0");
  });

  it.each([
    { isComposing: true, keyCode: 0 },
    { isComposing: false, keyCode: 229 },
  ])("leaves input-method Escape and Tab native: %j", (composition) => {
    const onClose = vi.fn();
    render(
      <SettingsDialog onClose={onClose}>
        <input aria-label="IME text" />
      </SettingsDialog>,
    );
    const first = screen.getByRole("button", { name: "Close settings" });
    const input = screen.getByRole("textbox", { name: "IME text" });
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Tab", ...composition })).toBe(true);
    expect(input).toHaveFocus();
    expect(fireEvent.keyDown(input, { key: "Escape", ...composition })).toBe(
      true,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(input).toHaveFocus();

    expect(fireEvent.keyDown(input, { key: "Tab", keyCode: 9 })).toBe(false);
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape", keyCode: 27 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab and restores the opener after StrictMode effect replay", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const user = userEvent.setup();
    const view = render(
      <StrictMode>
        <SettingsDialog onClose={() => undefined}>
          <button type="button">Apply preference</button>
        </SettingsDialog>
      </StrictMode>,
    );
    const first = screen.getByRole("button", { name: "Close settings" });
    const last = screen.getByRole("button", { name: "Apply preference" });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    opener.focus();
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
    view.unmount();
    await Promise.resolve();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it.each([false, true])(
    "restores focus after nested modal close (outer closes first: %s)",
    async (closeOuterFirst) => {
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
      const innerOpener = screen.getByRole("button", { name: "Open inner" });
      expect(innerOpener).toHaveFocus();
      fireEvent.click(innerOpener);
      if (closeOuterFirst) {
        fireEvent.click(
          screen.getByRole("button", { name: "Close outer first" }),
        );
        expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull();
        expect(screen.getByRole("dialog", { name: "Inner" })).toContainElement(
          document.activeElement as HTMLElement,
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "Close inner" }));
      await Promise.resolve();
      expect(closeOuterFirst ? opener : innerOpener).toHaveFocus();
    },
  );

  it("recovers replaced controls without stealing focus from a newer modal", async () => {
    function DeferredDialogs({
      ready,
      topOpen,
    }: {
      ready: boolean;
      topOpen: boolean;
    }) {
      const outerRef = useModalFocus<HTMLDivElement>(true, "deferred");
      const topRef = useModalFocus<HTMLDivElement>(topOpen, "newer");
      return (
        <>
          <div
            ref={outerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Deferred"
            tabIndex={-1}
          >
            <div key={ready ? "ready" : "loading"} ref={recoverModalFocus}>
              <button type="button">{ready ? "Files" : "Close loading"}</button>
            </div>
          </div>
          {topOpen ? (
            <div
              ref={topRef}
              role="dialog"
              aria-modal="true"
              aria-label="Newer"
              tabIndex={-1}
            >
              <button type="button">Close newer</button>
            </div>
          ) : null}
        </>
      );
    }

    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<DeferredDialogs ready={false} topOpen={false} />);
    expect(screen.getByRole("button", { name: "Close loading" })).toHaveFocus();
    view.rerender(<DeferredDialogs ready topOpen={false} />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveFocus();
    view.rerender(<DeferredDialogs ready topOpen />);
    view.rerender(<DeferredDialogs ready={false} topOpen />);
    expect(screen.getByRole("button", { name: "Close newer" })).toHaveFocus();
    view.rerender(<DeferredDialogs ready={false} topOpen={false} />);
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "Close loading" })).toHaveFocus();
    view.unmount();
    await Promise.resolve();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
