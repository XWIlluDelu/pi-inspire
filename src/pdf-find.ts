/** In-document find for the static PDF reader. Matches are counted inside
 * individual text items (one rendered text-layer span each), so the reader can
 * highlight the exact span; a phrase split across items is not reported. */

export interface PdfFindMatch {
  /** One-based page number. */
  page: number;
  /** Zero-based occurrence among this page's matches, in reading order. */
  occurrence: number;
}

export function normalizeFindQuery(query: string): string {
  return query.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  const haystack = text.replace(/\s+/gu, " ").toLocaleLowerCase();
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index >= 0;
    index = haystack.indexOf(needle, index + needle.length)
  )
    count += 1;
  return count;
}

export function pageMatches(
  page: number,
  items: readonly string[],
  needle: string,
): PdfFindMatch[] {
  let occurrence = 0;
  const matches: PdfFindMatch[] = [];
  for (const item of items) {
    const count = countOccurrences(item, needle);
    for (let i = 0; i < count; i += 1)
      matches.push({ page, occurrence: occurrence++ });
  }
  return matches;
}

/** Text-layer leaf spans in reading order, matching PDF.js text items. */
function textLayerSpans(layer: Element): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>("span")].filter(
    (span) =>
      !span.classList.contains("markedContent") && !span.querySelector("span"),
  );
}

/** Mark the span holding the given occurrence; returns it for scrolling. */
export function markOccurrence(
  layer: Element,
  needle: string,
  occurrence: number,
  className: string,
): HTMLElement | null {
  for (const marked of layer.querySelectorAll(`.${className}`))
    marked.classList.remove(className);
  if (!needle) return null;
  let seen = 0;
  for (const span of textLayerSpans(layer)) {
    const count = countOccurrences(span.textContent ?? "", needle);
    if (occurrence < seen + count) {
      span.classList.add(className);
      return span;
    }
    seen += count;
  }
  return null;
}

export interface PdfOutlineEntry {
  title: string;
  page: number;
  depth: number;
}
