import {
  fuzzySearchMatchRanges,
  mergeSearchMatchRanges,
  searchMatchRanges,
} from "./components/SearchMatchText";

function phraseMatchRanges(text: string, phrase: string) {
  let normalized = "";
  const offsets: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/\s+|\S/gu)) {
    const whitespace = /^\s/u.test(match[0]);
    const value = whitespace ? " " : match[0];
    normalized += value;
    for (let i = 0; i < value.length; i++)
      offsets.push({
        start: match.index + (whitespace ? 0 : i),
        end: match.index + (whitespace ? match[0].length : i + 1),
      });
  }
  return searchMatchRanges(normalized, [phrase.replace(/\s+/gu, " ")]).map(
    ({ start, end }) => ({
      start: offsets[start]!.start,
      end: offsets[end - 1]!.end,
    }),
  );
}

/** Follow Pi's quote/token grammar without executing user regex on the UI thread.
 * Hidden body/ID/path matches can return a row without a visible-title match. */
export function sessionSearchMatchRanges(text: string, query: string) {
  query = query.trim();
  if (!query || query.startsWith("re:")) return [];
  const tokens: Array<{ phrase: boolean; value: string }> = [];
  let quoted = false;
  let buffer = "";
  const flush = (phrase: boolean) => {
    const value = buffer.trim();
    if (value) tokens.push({ phrase, value });
    buffer = "";
  };
  for (const character of query) {
    if (character === '"') {
      flush(quoted);
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(character)) flush(false);
    else buffer += character;
  }
  flush(false);
  const parsed = quoted
    ? query.split(/\s+/u).map((value) => ({ phrase: false, value }))
    : tokens;
  return mergeSearchMatchRanges(
    parsed.flatMap((token) => {
      if (token.phrase) return phraseMatchRanges(text, token.value);
      const fold = (value: string) => value.toLowerCase();
      const primary = fuzzySearchMatchRanges(text, token.value, fold, false);
      if (primary.length) return primary;
      // Pi also accepts letter/digit tokens in the opposite order.
      const swapped = token.value
        .toLowerCase()
        .match(/^([a-z]+)([0-9]+)$|^([0-9]+)([a-z]+)$/u);
      return swapped
        ? fuzzySearchMatchRanges(
            text,
            (swapped[2] ?? swapped[4])! + (swapped[1] ?? swapped[3])!,
            fold,
            false,
          )
        : [];
    }),
  );
}
