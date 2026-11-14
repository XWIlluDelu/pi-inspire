import { isComposingKeyboardEvent } from "./keyboard-input";

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "getModifierState"
>;

const terminalChords = {
  new: { key: "Backquote", hint: "Ctrl+Shift+`" },
  next: { key: "PageDown", hint: "Ctrl+PageDown" },
  previous: { key: "PageUp", hint: "Ctrl+PageUp" },
} as const;
type TerminalChord = keyof typeof terminalChords;

export function terminalShortcutLabel(action: string): string | undefined {
  return Object.hasOwn(terminalChords, action)
    ? terminalChords[action as TerminalChord].hint
    : undefined;
}

/** Physical chords never take ownership from native text or composition. */
export function terminalShortcut(
  event: TerminalKeyEvent,
): TerminalChord | number | null {
  if (event.getModifierState("AltGraph") || isComposingKeyboardEvent(event))
    return null;
  if (event.altKey) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
    const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
    return digit && event.key === digit ? Number(digit) - 1 : null;
  }
  if (!event.ctrlKey && !event.metaKey) return null;
  if (event.shiftKey && event.code === terminalChords.new.key) return "new";
  if (event.key === terminalChords.next.key) return "next";
  if (event.key === terminalChords.previous.key) return "previous";
  return null;
}

/** Use the same browser platform identity as xterm for Option-key behavior. */
export { isMacKeyboardPlatform as isMacTerminalBrowser } from "./keyboard-input";

/** PTY input accepts pane shortcuts; ordinary editors and popup controls do not. */
export function isTerminalShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      '[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"]',
    )
  )
    return false;
  return (
    target.matches(".xterm-helper-textarea") ||
    !target.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
    )
  );
}
