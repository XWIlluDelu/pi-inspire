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
  // Reconstruct revisions independently. Sparse hunks need complete, bounded
  // source context; otherwise render literally rather than invent lexical state.
  const oldSource = lines.filter((line) => line.kind !== "add");
  const newSource = lines.filter((line) => line.kind !== "delete");
  const source = diff.source;
  const oldFull = source?.old.split("\n");
  const newFull = source?.new.split("\n");
  // The working file may change between the full-context and sparse reads.
  const complete =
    source &&
    oldSource.every(
      (line) => oldFull![line.oldLine! - 1] === line.text.slice(1),
    ) &&
    newSource.every(
      (line) => newFull![line.newLine! - 1] === line.text.slice(1),
    );
  const language = (name: string) =>
    diff.contextLimited && !complete ? "plaintext" : languageForFile(name);
  const oldHtml = highlightSourceLines(
    complete
      ? source.old
      : oldSource.map((line) => line.text.slice(1)).join("\n"),
    language(oldPath ?? path),
  );
  const newHtml = highlightSourceLines(
    complete
      ? source.new
      : newSource.map((line) => line.text.slice(1)).join("\n"),
    language(path),
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
      html:
        line.kind === "delete"
          ? oldHtml[complete ? line.oldLine! - 1 : oldIndex]
          : newHtml[complete ? line.newLine! - 1 : newIndex],
      changeIndex: changed ? changeIndex : null,
      startsChange,
    });
    if (line.kind !== "add") oldIndex += 1;
    if (line.kind !== "delete") newIndex += 1;
    insideChange = changed;
  }
  return { rows, changes: changeIndex + 1 };
}
