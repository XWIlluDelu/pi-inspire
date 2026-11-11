interface SearchableSession {
  id: string;
  cwd: string;
  name?: string;
  allMessagesText: string;
}

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();

function containsSubsequence(text: string, query: string): boolean {
  let cursor = 0;
  for (const character of query) {
    const index = text.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + character.length;
  }
  return true;
}

/** User-facing query syntax, independent of Pi's terminal implementation.
 * Terms are ANDed; quoted phrases match contiguous normalized text. A leading
 * re: selects a case-insensitive regex. Invalid/incomplete queries match nothing.
 * Matching stays inside the cancellable search worker. Results remain chronological.
 */
export function sessionSearchMatcher(
  query: string,
): (session: SearchableSession) => boolean {
  query = query.trim();
  const textOf = (session: SearchableSession) =>
    normalize(
      [
        session.name ?? "",
        session.id,
        session.cwd,
        session.allMessagesText,
      ].join(" "),
    );
  if (query.startsWith("re:")) {
    const pattern = query.slice(3).trim();
    if (!pattern) return () => false;
    try {
      const expression = new RegExp(pattern, "i");
      return (session) => expression.test(textOf(session));
    } catch {
      return () => false;
    }
  }

  const terms: Array<{ text: string; phrase: boolean }> = [];
  for (const match of query.matchAll(/"([^"]*)"|([^\s"]+)|(")/gu)) {
    if (match[3]) return () => false;
    const phrase = match[1] !== undefined;
    const text = normalize(match[1] ?? match[2]!).toLowerCase();
    if (text) terms.push({ text, phrase });
  }
  return (session) => {
    const fields = [
      session.name ?? "",
      session.id,
      session.cwd,
      session.allMessagesText,
    ].map((text) => normalize(text).toLowerCase());
    return terms.every((term) =>
      fields.some((text) =>
        term.phrase
          ? text.includes(term.text)
          : containsSubsequence(text, term.text),
      ),
    );
  };
}

const SNIPPET_LENGTH = 120;

/** Markdown syntax is noise in a one-line excerpt: keep link text, drop fence,
 * emphasis and heading markers. Matching then runs on what a reader sees. */
function readableText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(^|\s)#{1,6}\s+/gu, "$1")
    .replace(/\*{1,3}|~~|`+/gu, "")
    .replace(/^\s*>\s?/gmu, "");
}

/** A short excerpt around the first contiguous body match, so a search result
 * can show why it matched. Fuzzy subsequence matches and title/id/cwd matches
 * have no single location and return nothing rather than a misleading span. */
export function sessionSearchSnippet(
  query: string,
  messagesText: string,
): string | undefined {
  query = query.trim();
  const text = normalize(readableText(messagesText));
  if (!query || !text) return undefined;
  let start = -1;
  let length = 0;
  if (query.startsWith("re:")) {
    const pattern = query.slice(3).trim();
    if (!pattern) return undefined;
    try {
      const match = new RegExp(pattern, "i").exec(text);
      if (!match || match[0].length === 0) return undefined;
      start = match.index;
      length = match[0].length;
    } catch {
      return undefined;
    }
  } else {
    const lower = text.toLowerCase();
    const terms = [...query.matchAll(/"([^"]*)"|([^\s"]+)/gu)]
      .map((match) => normalize(match[1] ?? match[2] ?? "").toLowerCase())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    for (const term of terms) {
      const index = lower.indexOf(term);
      if (index >= 0) {
        start = index;
        length = term.length;
        break;
      }
    }
    if (start < 0) return undefined;
  }
  // A short lead keeps the hit near the start of a narrow navigation row,
  // even when the match sits at the end of the text.
  let from = Math.max(0, start - 12);
  let to = Math.min(text.length, from + Math.max(SNIPPET_LENGTH, length));
  // Keep whole words at the cut points when the edge falls mid-word.
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space > 0 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > start + length) to = space;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}
