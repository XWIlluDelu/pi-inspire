/** Unified-diff recognition for tool results. Edit-style tools report their
 * change as a unified diff; rendering it as colored lines instead of a raw
 * dump is the single biggest readability win in the transcript. */

type DiffLineType = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

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
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      parsed.push({ type: "hunk", text: line });
      hunks += 1;
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
    } else if (newRemaining > 0 && line.startsWith("+")) {
      parsed.push({ type: "add", text: line });
      changes += 1;
      newRemaining -= 1;
    } else if (oldRemaining > 0 && line.startsWith("-")) {
      parsed.push({ type: "del", text: line });
      changes += 1;
      oldRemaining -= 1;
    } else if (oldRemaining > 0 && newRemaining > 0 && line.startsWith(" ")) {
      parsed.push({ type: "context", text: line });
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      // File markers are metadata only outside their hunk body.
      parsed.push({ type: "meta", text: line });
      if (line.startsWith("+++") || line.startsWith("---")) fileMarkers += 1;
    }
  }
  if (hunks === 0 || changes === 0 || fileMarkers < 2) return null;
  return parsed;
}
