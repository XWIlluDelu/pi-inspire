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
export function compileSessionSearch(query: string): {
  matches: (session: SearchableSession) => boolean;
  snippet: (messagesText: string) => string | undefined;
} | null {
  query = query.trim();
  const fields = ({ name, id, cwd, allMessagesText }: SearchableSession) => [
    name ?? "",
    id,
    cwd,
    allMessagesText,
  ];
  if (query.startsWith("re:")) {
    const pattern = query.slice(3).trim();
    if (!pattern) return null;
    try {
      const expression = new RegExp(pattern, "i");
      return {
        matches: (session) =>
          expression.test(normalize(fields(session).join(" "))),
        snippet(messagesText) {
          const text = normalize(readableText(messagesText));
          const match = expression.exec(text);
          return match?.[0]
            ? excerpt(text, match.index, match[0].length)
            : undefined;
        },
      };
    } catch {
      return null;
    }
  }

  const terms: Array<{ text: string; phrase: boolean }> = [];
  for (const match of query.matchAll(/"([^"]*)"|([^\s"]+)|(")/gu)) {
    if (match[3]) return null;
    const phrase = match[1] !== undefined;
    const text = normalize(match[1] ?? match[2]!).toLowerCase();
    if (text) terms.push({ text, phrase });
  }
  terms.sort((left, right) => right.text.length - left.text.length);
  return {
    matches(session) {
      const values = fields(session).map((text) =>
        normalize(text).toLowerCase(),
      );
      return terms.every((term) =>
        values.some((text) =>
          term.phrase
            ? text.includes(term.text)
            : containsSubsequence(text, term.text),
        ),
      );
    },
    snippet(messagesText) {
      const text = normalize(readableText(messagesText));
      const lower = text.toLowerCase();
      for (const { text: term } of terms) {
        const start = lower.indexOf(term);
        if (start >= 0) return excerpt(text, start, term.length);
      }
    },
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

/** Bound the preview even when a single match spans the whole body. */
function excerpt(text: string, start: number, length: number): string {
  let from = Math.max(0, start - 12);
  // Keep whole words at the cut points when the edge falls mid-word.
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space > 0 && space < start) from = space + 1;
  }
  let to = Math.min(text.length, from + SNIPPET_LENGTH);
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > start + length) to = space;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}
