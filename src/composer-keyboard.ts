const TOUCH_COMPOSER_QUERY = "(hover: none) and (pointer: coarse)";

type ComposerKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing"
>;

/**
 * Desktop Enter submits while Shift+Enter inserts a line break. On touch-first
 * devices the software keyboard's Return key remains a native line break;
 * explicit Ctrl/Command+Enter from an attached keyboard can still submit.
 */
export function shouldSubmitComposerEnter(event: ComposerKeyEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing)
    return false;
  const touchFirst =
    typeof window !== "undefined" &&
    window.matchMedia(TOUCH_COMPOSER_QUERY).matches;
  return !touchFirst || event.ctrlKey || event.metaKey;
}
