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

/** Physical Alt+digit is a tab chord only when the layout did not generate
 * another character. AltGraph and native Option text/dead keys own their input. */
export function terminalTabShortcutIndex(
  event: TerminalKeyEvent,
): number | null {
  if (
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.getModifierState("AltGraph") ||
    isComposingKeyboardEvent(event)
  )
    return null;
  const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
  return digit && event.key === digit ? Number(digit) - 1 : null;
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
