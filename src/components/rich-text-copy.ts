import type { ClipboardEvent as ReactClipboardEvent } from "react";

function closestKatexBoundary(node: Node, root: HTMLElement): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  const katex = element?.closest(".katex") ?? null;
  if (!katex || !root.contains(katex)) return null;
  const display = katex.closest(".katex-display");
  return display && root.contains(display) ? display : katex;
}

function fragmentHtml(fragment: DocumentFragment): string {
  const wrapper = document.createElement("div");
  wrapper.append(fragment.cloneNode(true));
  return wrapper.innerHTML;
}

/** Build the clipboard projection used by the transcript's delegated copy
 * boundary. The supplied range is cloned, so neither selection nor Pi source
 * text is modified. */
export function projectKatexSelection(
  range: Range,
  root: HTMLElement,
): { plain: string; html: string } | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const selected = range.cloneRange();
  // Determine display identity in the original DOM. A cloned partial KaTeX
  // fragment no longer has its .katex-display ancestor, so expand endpoints
  // to the original formula boundary before cloning.
  const startKatex = closestKatexBoundary(selected.startContainer, root);
  const endKatex = closestKatexBoundary(selected.endContainer, root);
  if (startKatex) selected.setStartBefore(startKatex);
  if (endKatex) selected.setEndAfter(endKatex);

  const fragment = selected.cloneContents();
  if (!fragment.querySelector(".katex-mathml")) return null;
  const html = fragmentHtml(fragment);

  for (const mathml of [...fragment.querySelectorAll(".katex-mathml")]) {
    const source = mathml.querySelector("annotation")?.textContent;
    if (source == null) continue;
    const display = Boolean(mathml.closest(".katex-display"));
    const rendered = mathml.nextElementSibling;
    if (rendered?.classList.contains("katex-html")) rendered.remove();
    mathml.replaceWith(
      document.createTextNode(display ? `$$${source}$$` : `$${source}$`),
    );
  }
  return { plain: fragment.textContent ?? "", html };
}

export function handleRichTextCopy(
  event: ReactClipboardEvent<HTMLElement>,
): void {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !event.clipboardData
  )
    return;
  const projection = projectKatexSelection(
    selection.getRangeAt(0),
    event.currentTarget,
  );
  if (!projection) return;
  event.clipboardData.setData("text/plain", projection.plain);
  event.clipboardData.setData("text/html", projection.html);
  event.preventDefault();
}
