import hljs from "highlight.js/lib/common";

const MAX_HIGHLIGHTED_CHARACTERS = 64 * 1024;

/** Filename recognition complements highlight.js's language/extension aliases. */
export function languageForFile(name: string): string {
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (basename === "makefile" || basename === "gnumakefile") return "makefile";
  return /\.([a-z0-9]{1,12})$/.exec(basename)?.[1] ?? "plaintext";
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
