/** Amount of a focused control or its outline clipped by an overflow ancestor.
 * Use after keyboard focus and layout settle; zero means the whole ring fits. */
export function focusRingClipping(element: Element): number {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const extent = Math.max(
    0,
    Number.parseFloat(style.outlineWidth) +
      Number.parseFloat(style.outlineOffset),
  );
  let clipped = 0;
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const css = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) {
      clipped = Math.max(
        clipped,
        rect.left + Number.parseFloat(css.borderLeftWidth) - box.left + extent,
        box.right +
          extent -
          rect.right +
          Number.parseFloat(css.borderRightWidth),
      );
    }
    if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) {
      clipped = Math.max(
        clipped,
        rect.top + Number.parseFloat(css.borderTopWidth) - box.top + extent,
        box.bottom +
          extent -
          rect.bottom +
          Number.parseFloat(css.borderBottomWidth),
      );
    }
  }
  return clipped;
}
