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
  let hasFileHeader = false;
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]!;
    const line = lines[index]!;
    if (
      line.kind === "meta" &&
      line.text.startsWith("+++ ") &&
      previous.kind === "meta" &&
      previous.text.startsWith("--- ")
    )
      hasFileHeader = true;
    else if (hasFileHeader && (line.kind === "add" || line.kind === "delete"))
      return lines;
  }
  return null;
}
