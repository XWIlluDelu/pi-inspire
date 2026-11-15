import {
  isComposingKeyboardEvent,
  isMacKeyboardPlatform,
} from "./keyboard-input";

import { store } from "./store";

export const modelCycles = {
  "next-model": { key: "M", title: "Next model" },
  "previous-model": { key: "P", title: "Previous model" },
  thinking: { key: "R", title: "Cycle thinking level" },
} as const;
type ModelCycleAction = keyof typeof modelCycles;
export function runModelCycle(action: ModelCycleAction) {
  return action === "thinking"
    ? store.cycleThinking()
    : store.cycleModel(action === "next-model" ? 1 : -1);
}
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

export const workbenchShortcuts = {
  palette: { key: "k", title: "Open the command palette" },
  nav: { key: "b", title: "Toggle navigation panel" },
  ctx: { key: ".", title: "Toggle resources panel" },
  find: { key: "f", title: "Find in the focused transcript" },
} as const;

type WorkbenchShortcut = keyof typeof workbenchShortcuts;

export function workbenchShortcutLabel(action: WorkbenchShortcut): string {
  return `Ctrl/⌘+${workbenchShortcuts[action].key.toUpperCase()}`;
}

export function workbenchShortcut(
  event: ModelCycleKey,
): WorkbenchShortcut | null {
  if (event.ctrlKey === event.metaKey || event.altKey || event.shiftKey)
    return null;
  const key = event.key.toLowerCase();
  return (
    (Object.keys(workbenchShortcuts) as WorkbenchShortcut[]).find(
      (id) => workbenchShortcuts[id].key === key,
    ) ?? null
  );
}

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
    (Object.entries(modelCycles).find(([, cycle]) => key === cycle.key)?.[0] as
      | ModelCycleAction
      | undefined) ?? null
  );
}

export function modelCycleShortcut(
  action: ModelCycleAction,
  mac = isMacKeyboardPlatform(),
): string {
  return `${mac ? "Ctrl+⌘" : "Alt+Shift"}+${modelCycles[action].key}`;
}
