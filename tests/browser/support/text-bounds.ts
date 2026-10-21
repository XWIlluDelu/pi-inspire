/** Measure text-only status lines against their padded horizontal bounds.
 * Range rectangles expose clipped long tokens even when the element's own box
 * stays within its parent. Run after the UI has settled and fonts are ready. */
export function textOverflowsInlineBounds(element: Element): boolean {
  const frame = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const left =
    frame.left +
    Number.parseFloat(style.borderLeftWidth) +
    Number.parseFloat(style.paddingLeft);
  const right =
    frame.right -
    Number.parseFloat(style.borderRightWidth) -
    Number.parseFloat(style.paddingRight);
  const range = document.createRange();
  range.selectNodeContents(element);
  return (
    element.scrollWidth > element.clientWidth + 1 ||
    [...range.getClientRects()].some(
      (rect) => rect.left < left - 0.5 || rect.right > right + 0.5,
    )
  );
}
