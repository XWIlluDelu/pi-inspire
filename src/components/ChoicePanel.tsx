import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import {
  useFloatingMenuDismissal,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";

const bounds = {
  gap: 4,
  horizontalMargin: 12,
  verticalMargin: 8,
  maxWidth: 340,
  maxHeight: 300,
};

export function ChoicePanel({
  label,
  open,
  setOpen,
  children,
  trigger,
  className,
}: {
  label: string;
  open: boolean;
  setOpen(value: boolean): void;
  children: ReactNode;
  trigger: ReactNode;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const target = useCallback(() => {
    const context = opener.current;
    return (
      context && {
        context,
        anchor: context.getBoundingClientRect(),
        positioningRoot: context.closest<HTMLElement>(".overlay"),
        preferredWidth: 270,
      }
    );
  }, []);
  const placement = useFloatingMenuPlacement(open, target, bounds);
  const shown = open && placement !== null;
  useModalPortal(shown, opener, panel);
  useFloatingMenuDismissal(open, root, panel, () => setOpen(false));
  useEffect(() => {
    if (shown)
      panel.current
        ?.querySelector<HTMLElement>(
          "input:not(:disabled), select:not(:disabled), button:not(:disabled)",
        )
        ?.focus({ preventScroll: true });
  }, [shown]);
  return (
    <div className="choice-panel" ref={root}>
      <button
        type="button"
        className="choice-panel__trigger icon-button"
        ref={opener}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {createPortal(
        <div
          id={id}
          ref={panel}
          className={`choice-panel__body ${className ?? ""}`}
          role="dialog"
          aria-label={label}
          hidden={!shown}
          style={
            placement
              ? {
                  left: placement.left,
                  top: placement.top,
                  bottom: placement.bottom,
                  width: placement.width,
                  maxHeight: placement.maxHeight,
                }
              : undefined
          }
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            opener.current?.focus({ preventScroll: true });
          }}
        >
          {children}
        </div>,
        opener.current?.closest(".overlay") ?? document.body,
      )}
    </div>
  );
}
