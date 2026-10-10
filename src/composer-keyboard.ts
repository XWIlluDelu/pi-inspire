import type { DesktopSendKeyPreference } from "../shared/contracts";

import { isTouchFirstDevice } from "./input-device";

type ComposerKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
>;

/**
 * Touch-first Return is always a native line break, including from an attached
 * keyboard. Desktop submission follows the saved chord; every other Enter
 * combination remains available for multiline input.
 */
export function shouldSubmitComposerEnter(
  event: ComposerKeyEvent,
  desktopSendKey: DesktopSendKeyPreference,
): boolean {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.isComposing
  )
    return false;
  if (isTouchFirstDevice()) return false;
  const modifier = event.ctrlKey || event.metaKey;
  return desktopSendKey === "mod-enter" ? modifier : !modifier;
}
