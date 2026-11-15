import { Check, ChevronDown } from "lucide-react";
import {
  type ComponentProps,
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
  openRequest?: number;
  onOpenRequestHandled?: (id: number) => void;
  direction?: "up" | "down";
  onChange(value: Value): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
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
        148,
        anchor.width,
        options.some((option) => option.description) ? 280 : 0,
      ),
    };
  }, [options]);
  const placement = useFloatingMenuPlacement(open, resolve, bounds);
  useFloatingMenuDismissal(open, trigger, list.scrollRef, () => setOpen(false));
  const show = () => {
    if (props.disabled || !options.length) return;
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
    if (!props.disabled && options.length) {
      trigger.current?.focus({ preventScroll: true });
      show();
    }
    onOpenRequestHandled?.(openRequest);
  });

  return (
    <>
      <button
        {...props}
        ref={(node) => {
          trigger.current = node;
          if (typeof ref === "function") return ref(node);
          if (ref) ref.current = node;
        }}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? list.id : undefined}
        aria-activedescendant={open ? list.descendant(items) : undefined}
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
        <ChevronDown size={13} aria-hidden />
      </button>
      {open &&
        placement &&
        portal &&
        createPortal(
          <div
            className="dropdown-popup"
            style={{
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              width: placement.width,
              maxHeight: placement.maxHeight,
            }}
          >
            <OptionList
              list={list}
              options={items}
              label={label}
              onPick={select}
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
          </div>,
          portal,
        )}
    </>
  );
}
