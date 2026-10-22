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
