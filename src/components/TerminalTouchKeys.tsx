import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TerminalModifiers, TerminalTouchKey } from "../terminal-input";

const additionalKeys = [
  ["Tab", "Tab"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PgUp"],
  ["PageDown", "PgDn"],
] as const;
const arrowKeys = [
  ["ArrowLeft", "Arrow left", "←"],
  ["ArrowUp", "Arrow up", "↑"],
  ["ArrowDown", "Arrow down", "↓"],
  ["ArrowRight", "Arrow right", "→"],
] as const;

export function TerminalTouchKeys({
  disabled,
  modifiers,
  onToggleModifier,
  onKey,
}: {
  disabled: boolean;
  modifiers: TerminalModifiers;
  onToggleModifier(modifier: keyof TerminalModifiers): void;
  onKey(key: TerminalTouchKey): void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [visibleKeys, setVisibleKeys] = useState(1);
  const [canScrollStart, setCanScrollStart] = useState(false);
  const [canScrollEnd, setCanScrollEnd] = useState(false);
  const updateOverflow = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    // Keep every resting slot complete, including the wider Ctrl+C label.
    setVisibleKeys(
      Math.max(1, Math.min(9, Math.floor((node.clientWidth + 4) / 60))),
    );
    setCanScrollStart(node.scrollLeft > 1);
    setCanScrollEnd(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(scrollerRef.current!);
    observer.observe(contentRef.current!);
    updateOverflow();
    return () => observer.disconnect();
  }, [updateOverflow, visibleKeys]);

  return (
    <fieldset
      className="terminal-touch-keys"
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
    >
      <legend className="sr-only">Terminal keys</legend>
      <div
        className="terminal-touch-keys__extras"
        data-scroll-start={canScrollStart}
        data-scroll-end={canScrollEnd}
        style={{ "--visible-keys": visibleKeys } as CSSProperties}
      >
        <div
          className="terminal-touch-keys__scroller"
          ref={scrollerRef}
          onScroll={updateOverflow}
        >
          <div className="terminal-touch-keys__buttons" ref={contentRef}>
            <button type="button" onClick={() => onKey("Escape")}>
              Esc
            </button>
            <button type="button" onClick={() => onKey("Interrupt")}>
              Ctrl+C
            </button>
            {(["ctrl", "alt"] as const).map((modifier) => (
              <button
                key={modifier}
                type="button"
                className={modifiers[modifier] ? "is-active" : ""}
                aria-pressed={modifiers[modifier]}
                onClick={() => onToggleModifier(modifier)}
              >
                {modifier === "ctrl" ? "Ctrl" : "Alt"}
              </button>
            ))}
            {additionalKeys.map(([key, label]) => (
              <button key={key} type="button" onClick={() => onKey(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className="terminal-touch-keys__arrows"
        role="group"
        aria-label="Arrow keys"
      >
        {arrowKeys.map(([key, label, glyph]) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            onClick={() => onKey(key)}
          >
            {glyph}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
