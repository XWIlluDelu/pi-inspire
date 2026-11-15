import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { isTouchFirstDevice } from "../input-device";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  type FloatingMenuConstraints,
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
  constraints,
  searchable = false,
  onKeyDown,
  role = "dialog",
  readOnly = false,
  modelPicker,
  children,
}: {
  id?: string;
  label?: string;
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  constraints?: FloatingMenuConstraints;
  searchable?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  role?: "dialog" | "menu";
  /** A scrollable reader is the focus target and portals out of clipped chrome. */
  readOnly?: boolean;
  modelPicker?: { busy: boolean };
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const model = modelPicker !== undefined;
  const menu = !model && role === "menu";
  const portal = menu || readOnly;
  const target = useCallback(() => {
    const context = anchorRef.current;
    return (
      context && {
        context,
        anchor: context.getBoundingClientRect(),
        positioningRoot: portal
          ? null
          : context.closest<HTMLElement>(".overlay"),
        observe: [
          context,
          ...(searchable && context.form ? [context.form] : []),
        ],
        preferredWidth: constraints || menu ? undefined : 270,
      }
    );
  }, [anchorRef, menu, portal, searchable, constraints]);
  const placement = useFloatingMenuPlacement(
    open,
    target,
    constraints ?? (menu ? menuBounds : bounds),
  );
  const shown = open && placement !== null;
  useFloatingMenuDismissal(open, anchorRef, panel, onClose);
  useEffect(() => {
    if (!shown || model) return;
    if (readOnly || (searchable && isTouchFirstDevice())) {
      panel.current?.focus({ preventScroll: true });
      return;
    }
    const current = panel.current?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    const first = panel.current?.querySelector<HTMLElement>(
      menu ? '[role="menuitem"]:enabled' : ":is(input, select, button):enabled",
    );
    (current ?? first)?.focus({ preventScroll: !current });
  }, [shown, searchable, readOnly, model, menu]);
  if (model && !shown) return null;
  const body = (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both supported roles, menu and dialog, accept an accessible name.
    <div
      id={id}
      ref={panel}
      className={
        model
          ? "choice-panel__body model-picker__menu"
          : searchable
            ? "choice-panel__body choice-panel__body--search"
            : readOnly
              ? "choice-panel__body choice-panel__body--reader"
              : "choice-panel__body"
      }
      role={model ? undefined : role}
      aria-label={label}
      aria-busy={modelPicker?.busy}
      data-placement={placement?.direction}
      hidden={!shown}
      tabIndex={readOnly ? 0 : searchable ? -1 : undefined}
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
        if (
          event.defaultPrevented ||
          isComposingKeyboardEvent(event.nativeEvent)
        )
          return;
        if (event.key === "Escape" || (portal && event.key === "Tab")) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
          return;
        }
        onKeyDown?.(event);
        if (
          !menu ||
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        )
          return;
        const actions = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:enabled',
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
  return portal ? shown && createPortal(body, document.body) : body;
}
