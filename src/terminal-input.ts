export interface TerminalModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export const NO_TERMINAL_MODIFIERS: TerminalModifiers = {
  ctrl: false,
  alt: false,
};

export type TerminalTouchKey =
  | "Escape"
  | "Tab"
  | "Interrupt"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

/** null leaves xterm-generated escape sequences outside the text-key latch.
 * Paste must clear the latch before calling xterm.paste(). */
export function terminalTextInput(
  value: string,
  modifiers: TerminalModifiers,
): string | null {
  if (!value || (value.startsWith("\u001b") && value.length > 1)) return null;
  const singleCharacter =
    value.length === 1 ||
    (value.length === 2 && value.codePointAt(0)! > 0xffff);
  if (!singleCharacter) return value;
  let input = value;
  if (modifiers.ctrl) {
    const code = value.charCodeAt(0);
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    if (upper >= 64 && upper <= 95) input = String.fromCharCode(upper - 64);
    else if (value === " ") input = "\u0000";
    else if (value === "?") input = "\u007f";
  }
  return modifiers.alt ? `\u001b${input}` : input;
}

const CURSOR_FINAL = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
} as const;

export function terminalTouchInput(
  key: TerminalTouchKey,
  modifiers: TerminalModifiers,
  applicationCursorKeys: boolean,
): string {
  const modifier = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  switch (key) {
    case "Interrupt":
      return "\u0003";
    case "Escape":
      return modifiers.alt ? "\u001b\u001b" : "\u001b";
    case "Tab":
      return modifiers.alt ? "\u001b\t" : "\t";
    case "PageUp":
    case "PageDown": {
      const page = key === "PageUp" ? 5 : 6;
      return modifier === 1 ? `\u001b[${page}~` : `\u001b[${page};${modifier}~`;
    }
    default: {
      const final = CURSOR_FINAL[key];
      return modifier === 1
        ? `\u001b${applicationCursorKeys ? "O" : "["}${final}`
        : `\u001b[1;${modifier}${final}`;
    }
  }
}
