import type { GitDiffLine, GitDiffResponse } from "../shared/contracts";
import { highlightSourceLines, languageForFile } from "./syntax-highlighting";

export interface SourceDiffRow {
  line: GitDiffLine;
  html: string;
  changeIndex: number | null;
  startsChange: boolean;
}

export interface SourceDiffProjection {
  rows: SourceDiffRow[];
  changes: number;
}

export function sourceDiffRows(
  diff: Extract<GitDiffResponse, { kind: "text" }>,
  oldPath?: string,
): SourceDiffProjection {
  const lines = diff.lines.filter(
    (line) =>
      line.kind === "context" || line.kind === "add" || line.kind === "delete",
  );
  const path = diff.path.utf8Path ?? diff.path.display;
  // The Host requests full-source context. Reconstruct each revision separately
  // so a deleted comment/string delimiter cannot affect the new source's tokens.
  const oldSource = lines.filter((line) => line.kind !== "add");
  const newSource = lines.filter((line) => line.kind !== "delete");
  const oldHtml = highlightSourceLines(
    oldSource.map((line) => line.text.slice(1)).join("\n"),
    languageForFile(oldPath ?? path),
  );
  const newHtml = highlightSourceLines(
    newSource.map((line) => line.text.slice(1)).join("\n"),
    languageForFile(path),
  );
  let oldIndex = 0;
  let newIndex = 0;
  const rows: SourceDiffRow[] = [];
  let changeIndex = -1;
  let insideChange = false;
  for (const line of diff.lines) {
    if (
      line.kind !== "context" &&
      line.kind !== "add" &&
      line.kind !== "delete"
    ) {
      insideChange = false;
      continue;
    }
    const changed = line.kind === "add" || line.kind === "delete";
    const startsChange = changed && !insideChange;
    if (startsChange) changeIndex += 1;
    rows.push({
      line,
      // Context rows describe the selected (new) source; deletions belong to
      // the old source. Both indices advance on shared context.
      html: line.kind === "delete" ? oldHtml[oldIndex] : newHtml[newIndex],
      changeIndex: changed ? changeIndex : null,
      startsChange,
    });
    if (line.kind !== "add") oldIndex += 1;
    if (line.kind !== "delete") newIndex += 1;
    insideChange = changed;
  }
  return { rows, changes: changeIndex + 1 };
}
