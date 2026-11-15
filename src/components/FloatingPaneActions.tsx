import { ChevronRight, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";

export function FloatingPaneActions({
  label,
  className,
  children,
  readingSurface,
  owner,
  onKeyDown,
}: {
  label: string;
  className: string;
  children: ReactNode;
  readingSurface?: React.RefObject<HTMLElement | null>;
  owner: unknown;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const [expanded, setExpanded] = useState(true);
  const actions = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setExpanded(true);
    const surface = readingSurface?.current;
    if (!surface) return;
    const collapse = (event: Event) => {
      if (
        event.target instanceof Node &&
        !toggle.current?.parentElement?.contains(event.target)
      )
        setExpanded(false);
    };
    surface.addEventListener("pointerdown", collapse, true);
    surface.addEventListener("wheel", collapse, {
      passive: true,
      capture: true,
    });
    return () => {
      surface.removeEventListener("pointerdown", collapse, true);
      surface.removeEventListener("wheel", collapse, true);
    };
  }, [readingSurface, owner]);

  const toggleLabel = `${expanded ? "Hide" : "Show"} ${label}`;
  return (
    <div
      className={`floating-pane-actions ${className}`}
      role="toolbar"
      aria-label={label.charAt(0).toUpperCase() + label.slice(1)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          !expanded ||
          isComposingKeyboardEvent(event.nativeEvent)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        toggle.current?.focus();
      }}
    >
      <div
        className="floating-pane-actions__buttons"
        ref={actions}
        hidden={!expanded}
      >
        {children}
      </div>
      <button
        type="button"
        className="icon-button floating-pane-actions__toggle"
        ref={toggle}
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded)
            requestAnimationFrame(() => {
              actions.current
                ?.querySelector<HTMLElement>("button:enabled, summary")
                ?.focus();
            });
        }}
      >
        {expanded ? (
          <ChevronRight size={16} aria-hidden />
        ) : (
          <MoreHorizontal size={16} aria-hidden />
        )}
      </button>
    </div>
  );
}
