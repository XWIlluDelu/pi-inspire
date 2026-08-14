/** Unified-diff recognition for tool results. Edit-style tools report their
 * change as a unified diff; rendering it as colored lines instead of a raw
 * dump is the single biggest readability win in the transcript. */

export type DiffLineType = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

const META_PREFIXES = [
  "diff ",
  "index ",
  "new file",
  "deleted file",
  "rename ",
  "similarity ",
  "old mode",
  "new mode",
  "\\ No newline",
];

/**
 * Parse text as a unified diff, or return null when it is not one.
 *
 * Recognition is deliberately strict — a hunk header plus both file markers
 * must be present — so prose that merely contains lines starting with "-"
 * (Markdown bullets) or "+" never gets recolored.
 */
export function parseUnifiedDiff(text: string): DiffLine[] | null {
  if (!text.includes("@@") || !text.includes("---") || !text.includes("+++"))
    return null;
  const lines = text.split("\n");
  const parsed: DiffLine[] = [];
  let hunks = 0;
  let changes = 0;
  let fileMarkers = 0;
  let sawHunk = false;
  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      parsed.push({ type: "hunk", text: line });
      hunks += 1;
      sawHunk = true;
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      parsed.push({ type: "meta", text: line });
      fileMarkers += 1;
    } else if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      parsed.push({ type: "meta", text: line });
    } else if (sawHunk && line.startsWith("+")) {
      parsed.push({ type: "add", text: line });
      changes += 1;
    } else if (sawHunk && line.startsWith("-")) {
      parsed.push({ type: "del", text: line });
      changes += 1;
    } else if (sawHunk) {
      parsed.push({ type: "context", text: line });
    } else {
      // Preamble before any diff structure (tool chatter, headings).
      parsed.push({ type: "meta", text: line });
    }
  }
  if (hunks === 0 || changes === 0 || fileMarkers < 2) return null;
  return parsed;
}
