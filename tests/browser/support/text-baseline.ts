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

/** Measure neighboring marks against the visible letters in one layout snapshot.
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
  line.append(...nodes, probe);
  label.append(line);
  const baseline = probe.getBoundingClientRect().top;
  label.replaceChildren(...nodes);
  const style = getComputedStyle(label);
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = style.font;
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
