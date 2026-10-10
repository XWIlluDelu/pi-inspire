/** Primary touch input, rather than a narrow desktop window or hybrid touch screen. */
export function isTouchFirstDevice(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
