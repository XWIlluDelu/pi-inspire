import {
  isComposingKeyboardEvent,
  isMacKeyboardPlatform,
} from "./keyboard-input";

type ModelCycleAction = "next-model" | "previous-model" | "thinking";
type ModelCycleKey = Pick<
  KeyboardEvent,
  | "key"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "getModifierState"
>;

const CYCLE_KEYS: Record<ModelCycleAction, string> = {
  "next-model": "M",
  "previous-model": "P",
  thinking: "R",
};

/** Option is text input on Mac. Use Control+Command there, and preserve the
 * existing Alt+Shift chord elsewhere only when it actually produces its letter.
 * A physical key code must never turn another layout's character into an action. */
export function modelCycleAction(
  event: ModelCycleKey,
  mac = isMacKeyboardPlatform(),
): ModelCycleAction | null {
  if (isComposingKeyboardEvent(event) || event.getModifierState("AltGraph"))
    return null;
  const modifiers = mac
    ? event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey
    : event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
  if (!modifiers) return null;
  const key = event.key.toUpperCase();
  return (
    (Object.entries(CYCLE_KEYS).find(([, letter]) => key === letter)?.[0] as
      | ModelCycleAction
      | undefined) ?? null
  );
}

export function modelCycleShortcut(
  action: ModelCycleAction,
  mac = isMacKeyboardPlatform(),
): string {
  return `${mac ? "Ctrl+⌘" : "Alt+Shift"}+${CYCLE_KEYS[action]}`;
}
