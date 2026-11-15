const CARET_LAYOUT_PROPERTIES = [
  "box-sizing",
  "width",
  "height",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow-x",
  "overflow-y",
  "scrollbar-gutter",
  "scrollbar-width",
  "direction",
  "writing-mode",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "text-rendering",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const;

function logicalEdgeFallback(
  value: string,
  caret: number,
  edge: "first" | "last",
): boolean {
  return edge === "first"
    ? caret === 0 || value.lastIndexOf("\n", caret - 1) < 0
    : value.indexOf("\n", caret) < 0;
}

function mountTextareaMirror(
  textarea: HTMLTextAreaElement,
  left: number,
  top: number,
): {
  mirror: HTMLDivElement;
  text: Text;
  computed: CSSStyleDeclaration;
} {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "fixed";
  mirror.style.left = `${left}px`;
  mirror.style.top = `${top}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  for (const property of CARET_LAYOUT_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  const text = document.createTextNode(textarea.value);
  mirror.append(text);
  document.body.append(mirror);
  return { mirror, text, computed };
}

function collapsedCaretRect(text: Node, offset: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  return range.getClientRects()[0] ?? null;
}

interface TextareaCaretLineBounds {
  top: number;
  bottom: number;
}

/** Locate the caret's visible line box without changing textarea selection. */
export function textareaCaretLineBounds(
  textarea: HTMLTextAreaElement,
  caret = textarea.selectionStart,
): TextareaCaretLineBounds | null {
  const value = textarea.value;
  const bounds = textarea.getBoundingClientRect();
  if (!value || bounds.width <= 0) return null;

  let mirror: HTMLDivElement | null = null;
  try {
    const mounted = mountTextareaMirror(textarea, bounds.left, bounds.top);
    mirror = mounted.mirror;
    mirror.scrollLeft = textarea.scrollLeft;
    mirror.scrollTop = textarea.scrollTop;
    const offset = Math.max(0, Math.min(value.length, caret));
    const rect = collapsedCaretRect(mounted.text, offset);
    if (!rect) return null;
    const fontSize =
      Number.parseFloat(mounted.computed.fontSize) || rect.height;
    const lineHeight = Math.max(
      rect.height,
      Number.parseFloat(mounted.computed.lineHeight) || fontSize,
    );
    const renderedHeight = rect.height || fontSize;
    const top = rect.top - Math.max(0, lineHeight - renderedHeight) / 2;
    return { top, bottom: top + lineHeight };
  } catch {
    return null;
  } finally {
    mirror?.remove();
  }
}

/** Measure the browser's wrapped visual line without changing textarea selection. */
export function isTextareaCaretOnVisualEdge(
  textarea: HTMLTextAreaElement,
  edge: "first" | "last",
): boolean {
  const value = textarea.value;
  const caret = textarea.selectionStart;
  const fallback = logicalEdgeFallback(value, caret, edge);
  if (!value) return true;

  const bounds = textarea.getBoundingClientRect();
  if (bounds.width <= 0) return fallback;
  let mirror: HTMLDivElement | null = null;
  try {
    const mounted = mountTextareaMirror(textarea, -100000, 0);
    mirror = mounted.mirror;
    const currentTop = collapsedCaretRect(mounted.text, caret)?.top ?? null;
    const edgeTop =
      collapsedCaretRect(mounted.text, edge === "first" ? 0 : value.length)
        ?.top ?? null;
    if (currentTop === null || edgeTop === null) return fallback;
    return Math.abs(currentTop - edgeTop) < 0.5;
  } catch {
    return fallback;
  } finally {
    mirror?.remove();
  }
}
