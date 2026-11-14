import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  useFloatingMenuDismissal,
  useFloatingMenuPlacement,
} from "../use-floating-menu";

const bounds = {
  gap: 4,
  horizontalMargin: 12,
  verticalMargin: 8,
  maxWidth: 340,
  maxHeight: 300,
};
const menuBounds = {
  ...bounds,
  maxWidth: 268,
  preferredDirection: "down",
} as const;

export function ChoicePanel({
  label,
  open,
  setOpen,
  children,
  trigger,
  triggerLabel = label,
  triggerClassName = "icon-button",
  triggerRef,
}: {
  label: string;
  open: boolean;
  setOpen(value: boolean): void;
  children: ReactNode;
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const localOpener = useRef<HTMLButtonElement>(null);
  const opener = triggerRef ?? localOpener;
  return (
    <div className="choice-panel">
      <button
        type="button"
        className={`choice-panel__trigger ${triggerClassName}`}
        ref={opener}
        aria-label={triggerLabel}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      <AnchoredPanel
        id={id}
        label={label}
        open={open}
        anchorRef={opener}
        onClose={() => setOpen(false)}
      >
        {children}
      </AnchoredPanel>
    </div>
  );
}

export function AnchoredPanel({
  id,
  label,
  open,
  anchorRef,
  onClose,
  role = "dialog",
  children,
}: {
  id?: string;
  label: string;
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  role?: "dialog" | "menu";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const menu = role === "menu";
  const target = useCallback(() => {
    const context = anchorRef.current;
    return (
      context && {
        context,
        anchor: context.getBoundingClientRect(),
        positioningRoot: menu ? null : context.closest<HTMLElement>(".overlay"),
        observe: [context],
        preferredWidth: menu ? undefined : 270,
      }
    );
  }, [anchorRef, menu]);
  const placement = useFloatingMenuPlacement(
    open,
    target,
    menu ? menuBounds : bounds,
  );
  const shown = open && placement !== null;
  useFloatingMenuDismissal(open, anchorRef, panel, onClose);
  useEffect(() => {
    if (!shown) return;
    const current = panel.current?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    const first = panel.current?.querySelector<HTMLElement>(
      ":is(input, select, button):enabled",
    );
    (current ?? first)?.focus({ preventScroll: !current });
  }, [shown]);
  const body = (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both supported roles, menu and dialog, accept an accessible name.
    <div
      id={id}
      ref={panel}
      className="choice-panel__body"
      role={role}
      aria-label={label}
      hidden={!shown}
      style={
        placement
          ? {
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              width: menu ? "max-content" : placement.width,
              maxWidth: menu ? placement.width : undefined,
              maxHeight: placement.maxHeight,
            }
          : undefined
      }
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event.nativeEvent)) return;
        if (event.key === "Escape" || (menu && event.key === "Tab")) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
          return;
        }
        if (
          !menu ||
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        )
          return;
        const actions = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:enabled",
          ),
        ];
        const index = actions.findIndex(
          (action) => action === document.activeElement,
        );
        const edge = event.key === "Home" ? actions[0] : actions.at(-1);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = event.key.startsWith("Arrow")
          ? actions[(index + step + actions.length) % actions.length]
          : edge;
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {children}
    </div>
  );
  return menu ? shown && createPortal(body, document.body) : body;
}
