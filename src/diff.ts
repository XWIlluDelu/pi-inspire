/** Unified-diff recognition for tool results. Edit-style tools report their
 * change as a unified diff; rendering it as colored lines instead of a raw
 * dump is the single biggest readability win in the transcript. */

import { classifyUnifiedDiffLines } from "../shared/unified-diff";

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
  const parsed: DiffLine[] = [];
  let hunks = 0;
  let changes = 0;
  let fileMarkers = 0;
  for (const line of classifyUnifiedDiffLines(text.split("\n"))) {
    if (line.kind === "hunk") hunks += 1;
    else if (line.kind === "add" || line.kind === "delete") changes += 1;
    // File markers are metadata only outside their hunk body.
    else if (
      line.kind === "meta" &&
      (line.text.startsWith("+++") || line.text.startsWith("---"))
    )
      fileMarkers += 1;
    parsed.push({
      type: line.kind === "delete" ? "del" : line.kind,
      text: line.text,
    });
  }
  if (hunks === 0 || changes === 0 || fileMarkers < 2) return null;
  return parsed;
}
