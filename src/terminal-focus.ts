/** A short-lived permission for one activation frame, not a standing right to
 * reclaim focus when fonts, replay, or writer ownership become ready later. */
export function terminalActivationFocus(): () => boolean {
  const origin = document.activeElement;
  const allowed =
    origin === document.body ||
    origin === document.documentElement ||
    Boolean(
      origin?.matches("[data-terminal-focus-trigger], .xterm-helper-textarea"),
    );
  return () => allowed && document.activeElement === origin;
}
