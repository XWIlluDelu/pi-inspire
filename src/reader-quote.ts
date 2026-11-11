/** Quotes taken from a file reader into the composer. The result is ordinary
 * Markdown the user can edit; the location uses the same path/line notation
 * the transcript already resolves back into the reader. */

const MAX_QUOTE_CHARACTERS = 2_000;

type ReaderQuoteLocation =
  | { kind: "lines"; start: number; end: number }
  | { kind: "pages"; start: number; end: number }
  | { kind: "section"; heading: string }
  | null;

export function formatReaderQuote(
  text: string,
  source: string,
  location: ReaderQuoteLocation,
): string {
  let body = text
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (body.length > MAX_QUOTE_CHARACTERS)
    body = `${body.slice(0, MAX_QUOTE_CHARACTERS).trimEnd()} …`;
  const quoted = body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const where =
    location?.kind === "lines"
      ? `${source}:${location.start}${location.end > location.start ? `-${location.end}` : ""}`
      : location?.kind === "pages"
        ? `${source}, ${location.end > location.start ? `pages ${location.start}–${location.end}` : `page ${location.start}`}`
        : location?.kind === "section"
          ? `${source}, § ${location.heading}`
          : source;
  return `${quoted}\n>\n> — ${where}`;
}

/** Append a block to a draft with one blank line between blocks. */
export function appendDraftBlock(draft: string, block: string): string {
  const current = draft.replace(/\s+$/u, "");
  return current ? `${current}\n\n${block}\n\n` : `${block}\n\n`;
}

function lineAt(code: Element, container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(code, 0);
  range.setEnd(container, offset);
  return range.toString().split("\n").length;
}

function pageOf(node: Node): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const label =
    element?.closest(".pdf-preview__page")?.getAttribute("aria-label") ?? "";
  const match = /(\d+)\s*$/u.exec(label);
  return match ? Number(match[1]) : null;
}

/** Locate a selection inside a reader: Source line range, PDF page range, or
 * the nearest preceding heading of a rendered document. */
export function readerSelectionLocation(
  range: Range,
  root: HTMLElement,
): ReaderQuoteLocation {
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const code = startElement?.closest(".source-view__pre code");
  if (code && root.contains(code) && code.contains(range.endContainer)) {
    const start = lineAt(code, range.startContainer, range.startOffset);
    let end = lineAt(code, range.endContainer, range.endOffset);
    // A selection ending at the start of a line does not include that line.
    if (end > start && range.toString().endsWith("\n")) end -= 1;
    return { kind: "lines", start, end };
  }
  const firstPage = pageOf(range.startContainer);
  if (firstPage !== null) {
    const lastPage = pageOf(range.endContainer) ?? firstPage;
    return {
      kind: "pages",
      start: Math.min(firstPage, lastPage),
      end: Math.max(firstPage, lastPage),
    };
  }
  let heading: string | null = null;
  for (const candidate of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const position = candidate.compareDocumentPosition(range.startContainer);
    if (
      position & Node.DOCUMENT_POSITION_FOLLOWING ||
      position & Node.DOCUMENT_POSITION_CONTAINED_BY
    )
      heading = candidate.textContent?.replace(/\s+/gu, " ").trim() || heading;
    else break;
  }
  return heading ? { kind: "section", heading } : null;
}
