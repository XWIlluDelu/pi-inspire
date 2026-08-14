import type { GitFileChange, GitStatusResponse } from "../shared/contracts";

export interface GitFacetPresentation {
  mark: string;
  label: string;
}

/** Compact, user-facing repository identity shared by the topbar and context pane. */
export function gitHeadLabel(
  status: GitStatusResponse | null | undefined,
): string | null {
  if (!status || status.kind !== "repository") return null;
  if (status.head.kind === "branch") return status.head.name;
  if (status.head.kind === "unborn") return `${status.head.name} · unborn`;
  return `${status.head.oid.slice(0, 8)} · detached`;
}

/** `total` remains authoritative even when the right-pane file projection is bounded. */
export function gitChangeCount(
  status: GitStatusResponse | null | undefined,
): number | null {
  return status?.kind === "repository" ? status.total : null;
}

export function presentGitFacet(
  change: GitFileChange | undefined,
): GitFacetPresentation | null {
  if (!change) return null;
  if (change.conflict)
    return { mark: "!", label: `conflict ${change.conflict.code}` };
  if (change.untracked)
    return { mark: "U", label: "Untracked — not yet added to Git" };
  if (change.staged && change.unstaged)
    return { mark: "±", label: "staged and unstaged changes" };
  if (change.staged)
    return { mark: "S", label: `staged ${change.staged.kind}` };
  if (change.unstaged)
    return { mark: "M", label: `unstaged ${change.unstaged.kind}` };
  return null;
}

/** State color for identifier lists (file trees). Kept separate from the
 * facet mark so the two channels stay independent: the letter says which
 * state, the hue only says how severe. `ignored` never decorates — an
 * ignored file is intentionally invisible, not a state to act on. */
export type GitDecoration = "conflict" | "modified" | "untracked";

export function gitDecorationForChange(
  change: GitFileChange | undefined,
): GitDecoration | null {
  if (!change) return null;
  if (change.conflict) return "conflict";
  if (change.untracked) return "untracked";
  if (change.staged || change.unstaged) return "modified";
  return null;
}

/** Directory rollup: the most severe decoration among changed descendants,
 * conflict > modified > untracked (the VS Code precedence). Files without a
 * safe workspace projection cannot be attributed to the tree and are skipped
 * rather than guessed. */
export function gitDecorationForDirectory(
  status: GitStatusResponse | null | undefined,
  dirPath: string,
): GitDecoration | null {
  if (!status || status.kind !== "repository") return null;
  const prefix = `${dirPath}/`;
  let best: GitDecoration | null = null;
  for (const file of status.files) {
    const workspacePath = file.path.workspacePath;
    if (
      !workspacePath ||
      (workspacePath !== dirPath && !workspacePath.startsWith(prefix))
    )
      continue;
    const decoration = gitDecorationForChange(file);
    if (decoration === "conflict") return "conflict";
    if (decoration === "modified") best = "modified";
    else if (decoration === "untracked" && best === null) best = "untracked";
  }
  return best;
}
