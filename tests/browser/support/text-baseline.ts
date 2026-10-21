/** Measure a label's actual text baseline, not its line/control box center.
 * Run in the browser with locator.evaluate; restore the same child nodes before
 * returning so React and disclosure/copy controls keep their identity. */
export function textBaseline(element: Element): number {
  const nodes = [...element.childNodes];
  const line = document.createElement("span");
  const probe = document.createElement("span");
  probe.style.cssText =
    "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
  line.append(...nodes, probe);
  element.append(line);
  const baseline = probe.getBoundingClientRect().top;
  element.replaceChildren(...nodes);
  return baseline;
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

/** Measure neighboring marks against the first line's visible letters in one layout snapshot.
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
  const text = label.textContent!;
  const ink = ctx.measureText(
    style.textTransform === "uppercase" ? text.toUpperCase() : text,
  );
  const center =
    baseline + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2;
  return [...element.querySelectorAll(selectors.marks)].map((mark) => {
    const box = mark.getBoundingClientRect();
    return box.y + box.height / 2 - center;
  });
}
