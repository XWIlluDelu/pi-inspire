/** Measure a label's actual text baseline, not its line/control box center.
 * Run in the browser with locator.evaluate; restore the same child nodes before
 * returning so React and disclosure/copy controls keep their identity.
 * Use a shared ancestor for comparisons that may span a scroll frame. */
export function textBaseline(element: Element, relativeTo?: string): number {
  const nodes = [...element.childNodes];
  const line = document.createElement("span");
  const probe = document.createElement("span");
  probe.style.cssText =
    "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
  line.append(...nodes, probe);
  element.append(line);
  const baseline =
    probe.getBoundingClientRect().top -
    (relativeTo ? element.closest(relativeTo)!.getBoundingClientRect().top : 0);
  element.replaceChildren(...nodes);
  return baseline;
}

/** Compare painted disclosure strokes with the first visible letter in one layout snapshot. */
export function disclosureReadingOffset(
  chevron: Element,
  reading: Element,
): number {
  const svg = chevron as SVGSVGElement;
  const path = svg.querySelector("path")!;
  const stroke =
    (Number.parseFloat(getComputedStyle(path).strokeWidth) *
      svg.getBoundingClientRect().width) /
    svg.viewBox.baseVal.width;
  const walker = document.createTreeWalker(reading, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode()!;
  while (!text.textContent!.trim()) text = walker.nextNode()!;
  const start = text.textContent!.search(/\S/);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + 1);
  const style = getComputedStyle(text.parentElement!);
  const context = document.createElement("canvas").getContext("2d")!;
  context.font =
    style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const letter = context.measureText(text.textContent![start]!);
  const readingEdge =
    range.getBoundingClientRect().left - letter.actualBoundingBoxLeft;
  return path.getBoundingClientRect().left - stroke / 2 - readingEdge;
}

/** Range/Canvas baseline estimates can round each font size independently,
 * particularly in WebKit/CoreText. Compare their difference within one CSS px;
 * exact DOM edges, columns and padding keep their own tighter tolerances. */
export const FIRST_TEXT_BASELINE_TOLERANCE_PX = 1;

/** Estimate the first text baseline without changing grid baselines or :empty
 * selectors. Use after document.fonts.ready; see the estimate tolerance above. */
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

/** Measure neighboring marks against the first line's optical center in one layout snapshot.
 * Disclosure anchoring may scroll between separate browser evaluations. */
export function textMarkOffsets(
  element: Element,
  selectors: { label: string; marks: string },
): number[] {
  const label = element.querySelector(selectors.label)!;
  const nodes = [...label.childNodes];
  const line = document.createElement("span");
  const probe = document.createElement("span");
  probe.style.cssText =
    "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
  line.append(probe, ...nodes);
  label.append(line);
  const baseline = probe.getBoundingClientRect().top;
  label.replaceChildren(...nodes);
  const style = getComputedStyle(label);
  const ctx = document.createElement("canvas").getContext("2d")!;
  // Numeric variants can make the computed font shorthand serialize as empty.
  ctx.font =
    style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  // Icons sit midway between the x-height and cap-height centers, the
  // position shared by the workbench's icon rows. Sentence-case descenders
  // (the "y" in "Activity") would pull an ink-box center too low.
  const capHeight = ctx.measureText("H").actualBoundingBoxAscent;
  const xHeight = ctx.measureText("x").actualBoundingBoxAscent;
  const center = baseline - (capHeight + xHeight) / 4;
  return [...element.querySelectorAll(selectors.marks)].map((mark) => {
    const box = mark.getBoundingClientRect();
    return box.y + box.height / 2 - center;
  });
}
