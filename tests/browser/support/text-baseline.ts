/** Estimate the first text baseline without changing grid baselines or :empty
 * selectors. Wait for document.fonts.ready before measuring. */
export function firstTextBaseline(
  element: Element,
  relativeTo?: string,
): number | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const offset = node.textContent?.search(/\S/) ?? -1;
    if (offset < 0) continue;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const style = getComputedStyle(node.parentElement!);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font =
      style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return (
      range.getBoundingClientRect().top +
      ctx.measureText(node.textContent![offset]!).fontBoundingBoxAscent -
      (relativeTo
        ? element.closest(relativeTo)!.getBoundingClientRect().top
        : 0)
    );
  }
  return null;
}
