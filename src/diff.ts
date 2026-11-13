/** Unified-diff recognition for tool results. Edit-style tools report their
 * change as a unified diff; rendering it as colored lines instead of a raw
 * dump is the single biggest readability win in the transcript. */

import type { GitDiffLine } from "../shared/contracts";
import { classifyUnifiedDiffLines } from "../shared/unified-diff";

export type DiffLine = Pick<GitDiffLine, "kind" | "text">;

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
  const lines = classifyUnifiedDiffLines(text.split("\n"));
  let hunks = 0;
  let changes = 0;
  let fileMarkers = 0;
  for (const line of lines) {
    if (line.kind === "hunk") hunks += 1;
    else if (line.kind === "add" || line.kind === "delete") changes += 1;
    // File markers are metadata only outside their hunk body.
    else if (
      line.kind === "meta" &&
      (line.text.startsWith("+++") || line.text.startsWith("---"))
    )
      fileMarkers += 1;
  }
  if (hunks === 0 || changes === 0 || fileMarkers < 2) return null;
  return lines;
}
