import { Check, ChevronDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";

const MENU_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 520,
  maxHeight: 300,
};

interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Quiet select replacement following the APG select-only combobox pattern:
 * focus stays on the trigger, the popover is a listbox tracked through
 * aria-activedescendant. It exists because the native option list is
 * OS-drawn and can match neither theme nor typography.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled = false,
  direction = "down",
  display,
  className = "",
  title,
  openRequest,
  onOpenRequestHandled,
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Preferred direction; the menu flips when the viewport offers more room. */
  direction?: "up" | "down";
  /** Trigger text when it should differ from the selected option's label. */
  display?: string;
  className?: string;
  title?: string;
  openRequest?: number;
  onOpenRequestHandled?: (id: number) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const handledOpenRequest = useRef<number | null>(null);
  const described = options.some((option) => option.description);
  const constraints = useMemo(
    () => ({ ...MENU_CONSTRAINTS, preferredDirection: direction }),
    [direction],
  );
  const resolveTarget = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const anchor = trigger.getBoundingClientRect();
    return {
      context: trigger,
      anchor,
      preferredWidth: described ? 320 : Math.max(148, anchor.width),
      observe: [trigger],
    };
  }, [described]);
  const placement = useFloatingMenuPlacement(open, resolveTarget, constraints);
  useModalPortal(Boolean(open && placement), triggerRef, listRef);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const shown =
    display ?? (selectedIndex >= 0 ? options[selectedIndex]!.label : value);

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActive(Math.max(0, selectedIndex));
    setKeyboardActive(true);
    setOpen(true);
  };

  const pick = (option: DropdownOption) => {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (openRequest === undefined || handledOpenRequest.current === openRequest)
      return;
    handledOpenRequest.current = openRequest;
    if (!disabled && options.length > 0) {
      setActive(Math.max(0, selectedIndex));
      setKeyboardActive(true);
      setOpen(true);
      triggerRef.current?.focus({ preventScroll: true });
    }
    onOpenRequestHandled?.(openRequest);
  }, [
    disabled,
    onOpenRequestHandled,
    openRequest,
    options.length,
    selectedIndex,
  ]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      )
        setOpen(false);
    };
    window.addEventListener("pointerdown", onOutside);
    window.addEventListener("focusin", onOutside);
    return () => {
      window.removeEventListener("pointerdown", onOutside);
      window.removeEventListener("focusin", onOutside);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !keyboardActive) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active, keyboardActive, placement]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
      setKeyboardActive(true);
    if (event.key === "Escape") {
      // Closing the menu must not reach the global Escape abort.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[active];
      if (option) pick(option);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`dropdown ${className}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className="dropdown__trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-listbox` : undefined}
        aria-activedescendant={
          open && keyboardActive ? `${id}-option-${active}` : undefined
        }
        disabled={disabled}
        title={title ?? label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown__value">{shown}</span>
        <ChevronDown size={11} aria-hidden />
      </button>
      {open && placement
        ? createPortal(
            <div
              className="dropdown__menu dropdown__menu--floating"
              data-placement={placement.direction}
              data-keyboard-active={keyboardActive}
              style={{
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
              role="listbox"
              aria-label={label}
              id={`${id}-listbox`}
              ref={listRef}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  role="option"
                  id={`${id}-option-${index}`}
                  aria-selected={option.value === value}
                  className={`dropdown__option ${option.description ? "dropdown__option--described" : ""} ${keyboardActive && index === active ? "dropdown__option--active" : ""}`}
                  // Focus must stay on the trigger; mousedown would steal it.
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={(event) => {
                    if (event.pointerType === "touch") return;
                    setKeyboardActive(false);
                    setActive(index);
                  }}
                  onClick={() => pick(option)}
                >
                  <span className="dropdown__option-copy">
                    <span className="dropdown__option-label">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="dropdown__option-description">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {option.value === value ? (
                    <Check size={12} aria-hidden />
                  ) : null}
                </div>
              ))}
            </div>,
            triggerRef.current?.closest(".overlay") ?? document.body,
          )
        : null}
    </div>
  );
}
