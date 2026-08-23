import type { DesktopSendKeyPreference } from "../shared/contracts";

const TOUCH_COMPOSER_QUERY = "(hover: none) and (pointer: coarse)";

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
  const touchFirst =
    typeof window !== "undefined" &&
    window.matchMedia(TOUCH_COMPOSER_QUERY).matches;
  if (touchFirst) return false;
  const modifier = event.ctrlKey || event.metaKey;
  return desktopSendKey === "mod-enter" ? modifier : !modifier;
}
