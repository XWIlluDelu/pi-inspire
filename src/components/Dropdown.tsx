import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
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
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Which way the menu unfolds; the composer sits at the viewport bottom. */
  direction?: "up" | "down";
  /** Trigger text when it should differ from the selected option's label. */
  display?: string;
  className?: string;
  title?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const shown = display ?? (selectedIndex >= 0 ? options[selectedIndex]!.label : value);

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const pick = (option: DropdownOption) => {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Keyboard navigation keeps the active option visible (jsdom lacks
  // scrollIntoView, hence the guard).
  useEffect(() => {
    if (!open) return;
    const element = listRef.current?.children[active];
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
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
        type="button"
        role="combobox"
        className="dropdown__trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-listbox` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        disabled={disabled}
        title={title ?? label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown__value">{shown}</span>
        <ChevronDown size={11} aria-hidden />
      </button>
      {open ? (
        <div
          className={`dropdown__menu dropdown__menu--${direction}`}
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
              className={`dropdown__option ${index === active ? "dropdown__option--active" : ""}`}
              // Focus must stay on the trigger; mousedown would steal it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              <span className="dropdown__option-label">{option.label}</span>
              {option.value === value ? <Check size={12} aria-hidden /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
