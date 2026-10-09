import type { ReactNode } from "react";

export interface SearchMatchRange {
  start: number;
  end: number;
}

/** Match literal terms and preserve original-text offsets after case folding. */
export function searchMatchRanges(
  text: string,
  terms: readonly string[],
  fold: (value: string) => string = (value) => value.toLowerCase(),
): SearchMatchRange[] {
  const words = terms.map(fold).filter(Boolean);
  if (!words.length) return [];
  const folded = fold(text);
  // Lowercasing can expand a character (e.g. İ); map back to original text.
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    for (let i = 0; i < fold(character).length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  const matches: SearchMatchRange[] = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const start = folded.indexOf(word, from);
      if (start < 0) break;
      matches.push({
        start: starts[start],
        end: ends[start + word.length - 1],
      });
      from = start + 1;
    }
  }
  return mergeSearchMatchRanges(matches);
}

export function mergeSearchMatchRanges(
  matches: SearchMatchRange[],
): SearchMatchRange[] {
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchMatchRange[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start <= previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else merged.push({ ...match });
  }
  return merged;
}

/** Trace the same literal-first, greedy subsequence rule as model search. */
export function fuzzySearchMatchRanges(
  text: string,
  query: string,
  fold: (value: string) => string,
  preferLiteral = true,
): SearchMatchRange[] {
  query = fold(query.trim());
  if (!query) return [];
  if (preferLiteral) {
    const direct = searchMatchRanges(text, [query], fold);
    if (direct.length) return direct;
  }
  const folded = fold(text);
  const starts: number[] = [],
    ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    for (let i = 0; i < fold(character).length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  const matches: SearchMatchRange[] = [];
  let cursor = 0;
  for (const character of query) {
    const found = folded.indexOf(character, cursor);
    if (found < 0) return [];
    matches.push({
      start: starts[found],
      end: ends[found + character.length - 1],
    });
    cursor = found + 1;
  }
  return mergeSearchMatchRanges(matches);
}

/** Render a slice of matched text without changing its text or bidi boundary. */
export function SearchMatchText({
  text,
  ranges,
  offset = 0,
}: {
  text: string;
  ranges: readonly SearchMatchRange[];
  offset?: number;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(text.length, range.end - offset);
    if (end <= start) continue;
    nodes.push(
      text.slice(cursor, start),
      <span className="search-match" key={start}>
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
