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
