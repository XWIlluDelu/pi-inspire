/** Match the browser platform used for native Command/Option behavior, not
 * the remote Host OS or the current viewport/input method. */
export function isMacKeyboardPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /^(Macintosh|MacIntel|MacPPC|Mac68K)$/u.test(navigator.platform)
  );
}

type CompositionKeyEvent = Pick<KeyboardEvent, "isComposing"> &
  Partial<Pick<KeyboardEvent, "keyCode">>;

/** The last IME keydown may follow compositionend, so isComposing alone is not
 * sufficient. 229 still identifies that key as input-method-owned.
 * https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event#keydown_events_during_ime_composition
 */
export function isComposingKeyboardEvent(event: CompositionKeyEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
