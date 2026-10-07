import hljs from "highlight.js/lib/common";

const MAX_HIGHLIGHTED_CHARACTERS = 64 * 1024;

/** Filename recognition complements highlight.js's language/extension aliases. */
export function languageForFile(name: string): string {
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (basename === "makefile" || basename === "gnumakefile") return "makefile";
  return /\.([a-z0-9]{1,12})$/.exec(basename)?.[1] ?? "plaintext";
}

/** Split trusted highlighted markup into self-contained rows, preserving nested
 * multiline tokens. Highlight the source once, never each line independently. */
export function highlightSourceLines(text: string, language: string): string[] {
  const openSpans: string[] = [];
  return highlightSource(text, language)
    .split("\n")
    .map((line) => {
      const prefix = openSpans.join("");
      for (const [tag] of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
        if (tag === "</span>") openSpans.pop();
        else openSpans.push(tag);
      }
      return prefix + line + "</span>".repeat(openSpans.length);
    });
}

/** Unknown languages and large leaves stay readable, without auto-detection. */
export function highlightSource(text: string, language: string): string {
  if (text.length <= MAX_HIGHLIGHTED_CHARACTERS && hljs.getLanguage(language))
    return hljs.highlight(text, { language }).value;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
