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
  return (
    <fieldset
      className="terminal-touch-keys"
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
    >
      <legend className="sr-only">Terminal keys</legend>
      <div className="terminal-touch-keys__scroller">
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
