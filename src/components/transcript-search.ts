import { useEffect, useMemo, useState, type MutableRefObject } from "react";

export interface TranscriptSearchMatch {
  rowIndex: number;
  offset: number;
}

export type TranscriptSearchScope = "all" | "user" | "model";

export const TRANSCRIPT_SEARCH_SCOPES: Array<{
  value: TranscriptSearchScope;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "user", label: "User" },
  { value: "model", label: "Model" },
];

export interface TranscriptSearchRow {
  searchText: string;
  searchScope: Exclude<TranscriptSearchScope, "all"> | null;
}

/** Case-insensitive literal, non-overlapping matches over already-selected
 * transcript text. This is intentionally not a Markdown/DOM search index. */
export function findLiteralMatches(
  text: string,
  query: string,
  rowIndex: number,
): TranscriptSearchMatch[] {
  if (!query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: TranscriptSearchMatch[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, from);
    if (offset < 0) break;
    matches.push({ rowIndex, offset });
    from = offset + needle.length;
  }
  return matches;
}

export interface TranscriptSearchOptions<Row extends TranscriptSearchRow> {
  rows: readonly Row[];
  sessionId: string;
  searchOwnsViewportRef: MutableRefObject<boolean>;
  onClear: () => void;
  onNavigate: (rowIndex: number) => void;
}

/**
 * Owns the query/scope/current-match state for settled transcript text. The
 * viewport remains separately responsible for scrolling and follow ownership.
 */
export function useTranscriptSearch<Row extends TranscriptSearchRow>({
  rows,
  sessionId,
  searchOwnsViewportRef,
  onClear,
  onNavigate,
}: TranscriptSearchOptions<Row>) {
  const [query, setQueryState] = useState("");
  const [scope, setScopeState] = useState<TranscriptSearchScope>("all");
  const [currentMatch, setCurrentMatch] = useState(-1);
  searchOwnsViewportRef.current = query.length > 0 && currentMatch >= 0;

  const matches = useMemo(
    () =>
      rows.flatMap((row, rowIndex) =>
        scope === "all" || row.searchScope === scope
          ? findLiteralMatches(row.searchText, query, rowIndex)
          : [],
      ),
    [query, rows, scope],
  );

  useEffect(() => {
    searchOwnsViewportRef.current = false;
    setQueryState("");
    setCurrentMatch(-1);
  }, [searchOwnsViewportRef, sessionId]);

  useEffect(() => {
    setCurrentMatch((current) =>
      matches.length === 0 ? -1 : Math.min(current, matches.length - 1),
    );
  }, [matches.length]);

  const clear = () => {
    searchOwnsViewportRef.current = false;
    setQueryState("");
    setCurrentMatch(-1);
    onClear();
  };

  const setQuery = (next: string) => {
    if (!next) {
      clear();
      return;
    }
    setQueryState(next);
    setCurrentMatch(-1);
  };

  const setScope = (next: TranscriptSearchScope) => {
    setScopeState(next);
    setCurrentMatch(-1);
  };

  const clearCurrentMatch = () => {
    searchOwnsViewportRef.current = false;
    setCurrentMatch(-1);
  };

  const navigate = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    const next =
      currentMatch < 0
        ? direction === 1
          ? 0
          : matches.length - 1
        : (currentMatch + direction + matches.length) % matches.length;
    setCurrentMatch(next);
    onNavigate(matches[next]!.rowIndex);
  };

  return {
    query,
    scope,
    currentMatch,
    matches,
    clear,
    setQuery,
    setScope,
    clearCurrentMatch,
    navigate,
  };
}
