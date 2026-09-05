export const TERMINAL_MENU_SELECTOR = "details[data-terminal-menu]";

/** Only the focused terminal menu owns this dismissal. A containing modal can
 * invoke it from its capture-phase Escape owner without yielding shell keys. */
export function dismissTerminalMenu(
  root: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  if (!root || !(target instanceof Element)) return false;
  const menu = target.closest<HTMLDetailsElement>(
    `${TERMINAL_MENU_SELECTOR}[open]`,
  );
  if (!menu || !root.contains(menu)) return false;
  menu.open = false;
  menu
    .querySelector<HTMLElement>(":scope > summary")
    ?.focus({ preventScroll: true });
  return true;
}
