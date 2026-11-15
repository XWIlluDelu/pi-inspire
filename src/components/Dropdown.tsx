import { Check, ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  useFloatingMenuDismissal,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { OptionList, useOptionList } from "./OptionList";

export function Dropdown<Value extends string>({
  label,
  value,
  options,
  display,
  onChange,
  className,
  header,
  indicator,
  menuWidth,
  ref,
  openRequest,
  onOpenRequestHandled,
  direction = "down",
  ...props
}: Omit<ComponentProps<"button">, "value" | "onChange" | "children"> & {
  label: string;
  value: string;
  options: readonly { value: Value; label: string; description?: string }[];
  display?: string;
  header?: ReactNode;
  indicator?: ReactNode;
  menuWidth?: number;
  openRequest?: number;
  onOpenRequestHandled?: (id: number) => void;
  direction?: "up" | "down";
  onChange(value: Value): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const handled = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const list = useOptionList<Value>();
  const items = options.map((option) => ({
    key: option.value,
    value: option.value,
    selected: option.value === value,
    label: option.label,
    description: option.description,
  }));
  const bounds = useMemo(
    () => ({
      gap: 4,
      horizontalMargin: 12,
      verticalMargin: 8,
      maxWidth: 420,
      maxHeight: 300,
      preferredDirection: direction,
    }),
    [direction],
  );
  const resolve = useCallback(() => {
    const context = trigger.current;
    if (!context) return null;
    const anchor = context.getBoundingClientRect();
    return {
      context,
      anchor,
      observe: [context],
      positioningRoot: context.closest<HTMLElement>("dialog[open]"),
      preferredWidth: Math.max(
        menuWidth ?? 148,
        anchor.width,
        options.some((option) => option.description) ? 280 : 0,
      ),
    };
  }, [menuWidth, options]);
  const placement = useFloatingMenuPlacement(open, resolve, bounds);
  useFloatingMenuDismissal(open, trigger, panel, () => setOpen(false));
  const show = () => {
    if (props.disabled || (!options.length && !header)) return;
    setPortal(
      trigger.current?.closest<HTMLElement>("dialog[open]") ?? document.body,
    );
    list.activate(value);
    setOpen(true);
  };
  const select = (next: Value) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  useEffect(() => {
    if (openRequest === undefined || handled.current === openRequest) return;
    handled.current = openRequest;
    if (!props.disabled && (options.length || header)) {
      trigger.current?.focus({ preventScroll: true });
      show();
    }
    onOpenRequestHandled?.(openRequest);
  });

  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const placed = Boolean(placement);
  const composed = Boolean(header);
  useEffect(() => {
    if (open && placed && composed)
      panel.current
        ?.querySelector<HTMLElement>("input:enabled, button:enabled")
        ?.focus({ preventScroll: true });
  }, [open, placed, composed]);

  return (
    <>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Only the combobox branch carries an active descendant. */}
      <button
        {...props}
        ref={(node) => {
          trigger.current = node;
          if (typeof ref === "function") return ref(node);
          if (ref) ref.current = node;
        }}
        type="button"
        role={composed ? undefined : "combobox"}
        aria-label={label}
        aria-haspopup={composed ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-controls={
          open ? (composed ? `${list.id}-panel` : list.id) : undefined
        }
        aria-activedescendant={
          !composed && open ? list.descendant(items) : undefined
        }
        data-modal-autofocus={props.autoFocus || undefined}
        title={props.title ?? label}
        className={`dropdown-trigger ${className ?? ""}`}
        onClick={() => {
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event.nativeEvent)) return;
          if (!open) {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
              event.preventDefault();
              show();
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Tab") setOpen(false);
          else if (event.key === " ") {
            event.preventDefault();
            const item = items[list.indexOf(items)];
            if (item) select(item.value);
          } else
            list.navigate(event, items, select, { edges: true, wrap: true });
        }}
      >
        <span>
          {display ??
            options.find((option) => option.value === value)?.label ??
            value}
        </span>
        {indicator}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open &&
        placement &&
        portal &&
        createPortal(
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: The accessible name is used only for the composed dialog.
          <div
            ref={panel}
            className={`dropdown-popup${composed ? " thinking-selector__menu" : ""}`}
            id={composed ? `${list.id}-panel` : undefined}
            role={composed ? "dialog" : undefined}
            aria-label={composed ? label : undefined}
            onKeyDown={(event) => {
              if (!composed || isComposingKeyboardEvent(event.nativeEvent))
                return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              const active = (event.target as HTMLElement).closest(
                '[role="option"]',
              );
              if (
                !active ||
                !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
              )
                return;
              const entries = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="option"]',
                ),
              ];
              const index = entries.indexOf(active as HTMLElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? entries.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          entries.length - 1,
                          index + (event.key === "ArrowUp" ? -1 : 1),
                        ),
                      );
              event.preventDefault();
              entries[next]?.focus();
            }}
            style={{
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              width: placement.width,
              maxHeight: placement.maxHeight,
            }}
          >
            {header}
            {items.length > 0 && (
              <OptionList
                list={list}
                options={items}
                label={label}
                onPick={(next) => {
                  select(next);
                  if (composed) close();
                }}
                focusOptions={composed}
                optionButtons
                renderOption={(item) => {
                  const option = options.find(
                    ({ value }) => value === item.value,
                  );
                  return (
                    <>
                      <span>
                        {item.label}
                        {option?.description && (
                          <small>{option.description}</small>
                        )}
                      </span>
                      {item.selected && <Check size={13} aria-hidden />}
                    </>
                  );
                }}
              />
            )}
          </div>,
          portal,
        )}
    </>
  );
}
