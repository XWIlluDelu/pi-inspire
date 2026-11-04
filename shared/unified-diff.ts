import type { GitDiffLine } from "./contracts.js";

/**
 * Classifies unified-diff lines. A hunk header sets how many old and new lines
 * its body holds; only lines inside that body are additions, deletions or
 * context, so file markers and prose around hunks stay metadata.
 */
export function classifyUnifiedDiffLines(
  lines: Iterable<string>,
): GitDiffLine[] {
  const classified: GitDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      classified.push({ kind: "hunk", text, oldLine: null, newLine: null });
    } else if (newRemaining > 0 && text.startsWith("+")) {
      classified.push({ kind: "add", text, oldLine: null, newLine });
      newLine += 1;
      newRemaining -= 1;
    } else if (oldRemaining > 0 && text.startsWith("-")) {
      classified.push({ kind: "delete", text, oldLine, newLine: null });
      oldLine += 1;
      oldRemaining -= 1;
    } else if (oldRemaining > 0 && newRemaining > 0 && text.startsWith(" ")) {
      classified.push({ kind: "context", text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      classified.push({ kind: "meta", text, oldLine: null, newLine: null });
    }
  }
  return classified;
}
