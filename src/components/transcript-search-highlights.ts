import { useLayoutEffect, useRef } from "react";
import {
  findLiteralMatches,
  type TranscriptSearchScope,
} from "./transcript-search";

// Only searchable message bodies, never tool/thinking content or action labels.
// A row can contain several rich passages; nested bodies are visited only once.
const bodies = [
  ".rich-text",
  ".custom-message__body",
  ".assistant-error__message",
  ".shell-execution__command",
  ".shell-execution__output",
].join(",");
const excluded = "[hidden], .code-block__bar, .katex-mathml, annotation";
const blocks = "p, li, h1, h2, h3, h4, h5, h6, pre, tr, blockquote";

/** Map visible literal text to DOM ranges without inserting marks into React's
 * tree. Inline emphasis, syntax spans, selection and source-copy stay intact. */
export function renderedSearchRanges(row: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  let previousBlock: Element | null = null;
  const roots = Array.from(row.querySelectorAll<HTMLElement>(bodies));
  for (const root of roots) {
    if (roots.some((other) => other !== root && other.contains(root))) continue;
    const walker = row.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const parent = node.parentElement!;
      if (parent.closest(excluded)) continue;
      const block = parent.closest(blocks) ?? root;
      if (previousBlock && previousBlock !== block) text += "\n";
      previousBlock = block;
      nodes.push({ node, start: text.length });
      text += node.data;
    }
  }
  let startIndex = 0;
  let endIndex = 0;
  return findLiteralMatches(text, query, 0).flatMap(({ offset }) => {
    while (
      startIndex < nodes.length &&
      nodes[startIndex]!.start + nodes[startIndex]!.node.length <= offset
    )
      startIndex++;
    endIndex = Math.max(endIndex, startIndex);
    while (
      endIndex < nodes.length &&
      nodes[endIndex]!.start + nodes[endIndex]!.node.length <
        offset + query.length
    )
      endIndex++;
    const start = nodes[startIndex];
    const end = nodes[endIndex];
    if (!start || !end || start.start > offset) return [];
    const range = row.ownerDocument.createRange();
    range.setStart(start.node, offset - start.start);
    range.setEnd(end.node, offset + query.length - end.start);
    return [range];
  });
}

interface SearchableRow {
  searchText: string;
  searchScope: Exclude<TranscriptSearchScope, "all"> | null;
}

/** CSS Custom Highlights paint text without altering message DOM, copy output
 * or measured geometry. Observe only the mounted transcript while searching,
 * so deferred Markdown and virtual rows acquire highlights when they appear. */
export function useTranscriptSearchHighlights({
  root,
  rows,
  query,
  scope,
  match,
  revealVersion,
}: {
  root: HTMLElement | null;
  rows: readonly SearchableRow[];
  query: string;
  scope: TranscriptSearchScope;
  match: { rowIndex: number; offset: number } | undefined;
  revealVersion: number | null;
}) {
  const navigated = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!root || !query) {
      navigated.current = null;
      return;
    }
    if (
      typeof CSS === "undefined" ||
      !CSS.highlights ||
      typeof Highlight === "undefined"
    )
      return;
    const all = new Highlight();
    const current = new Highlight();
    current.priority = 1;
    CSS.highlights.set("transcript-match", all);
    CSS.highlights.set("transcript-current-match", current);
    let frame = 0;
    const update = () => {
      all.clear();
      current.clear();
      let selected: Range | undefined;
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-transcript-row]",
      )) {
        const index = Number(element.dataset.transcriptRow);
        const row = rows[index];
        if (!row || (scope !== "all" && row.searchScope !== scope)) continue;
        const sourceMatches = findLiteralMatches(row.searchText, query, index);
        if (!sourceMatches.length) continue;
        const ranges = renderedSearchRanges(element, query);
        for (const range of ranges) all.add(range);
        // Raw Markdown can match hidden link destinations or syntax. Do not
        // assign that source hit to an unrelated visible occurrence.
        if (
          match?.rowIndex === index &&
          ranges.length === sourceMatches.length
        ) {
          const ordinal = sourceMatches.findIndex(
            ({ offset }) => offset === match.offset,
          );
          selected = ranges[ordinal];
          if (selected) current.add(selected);
        }
      }
      // Deliberate navigation targets the occurrence, not just its (possibly
      // very long) message. Later parses/mounts may supply it; user scrolling
      // after that navigation must not repeatedly snap back.
      if (
        selected &&
        revealVersion !== null &&
        navigated.current !== revealVersion
      ) {
        const bounds = selected.getBoundingClientRect();
        if (bounds.width || bounds.height) {
          navigated.current = revealVersion;
          let parent = selected.startContainer.parentElement;
          while (parent && parent !== root) {
            const style = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            const hit = selected.getBoundingClientRect();
            if (
              parent.scrollHeight > parent.clientHeight &&
              /auto|scroll/.test(style.overflowY) &&
              (hit.top < box.top || hit.bottom > box.bottom)
            ) {
              parent.scrollTop +=
                (hit.top + hit.bottom - box.top - box.bottom) / 2;
            }
            if (
              parent.scrollWidth > parent.clientWidth &&
              /auto|scroll/.test(style.overflowX)
            ) {
              if (hit.right > box.right)
                parent.scrollLeft += hit.right - box.right + 8;
              else if (hit.left < box.left)
                parent.scrollLeft += hit.left - box.left - 8;
            }
            parent = parent.parentElement;
          }
          const viewport = root.getBoundingClientRect();
          const visible = selected.getBoundingClientRect();
          root.scrollTop +=
            (visible.top + visible.bottom - viewport.top - viewport.bottom) / 2;
        }
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "open", "class"],
    });
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (CSS.highlights.get("transcript-match") === all)
        CSS.highlights.delete("transcript-match");
      if (CSS.highlights.get("transcript-current-match") === current)
        CSS.highlights.delete("transcript-current-match");
    };
  }, [root, rows, query, scope, match, revealVersion]);
}
