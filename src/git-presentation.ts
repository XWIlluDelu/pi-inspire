import type { GitFileChange, GitStatusResponse } from "../shared/contracts";

export interface GitFacetPresentation { mark: string; label: string }

/** Compact, user-facing repository identity shared by the topbar and context pane. */
export function gitHeadLabel(status: GitStatusResponse | null | undefined): string | null {
  if (!status || status.kind !== "repository") return null;
  if (status.head.kind === "branch") return status.head.name;
  if (status.head.kind === "unborn") return `${status.head.name} · unborn`;
  return `${status.head.oid.slice(0, 8)} · detached`;
}

/** `total` remains authoritative even when the right-pane file projection is bounded. */
export function gitChangeCount(status: GitStatusResponse | null | undefined): number | null {
  return status?.kind === "repository" ? status.total : null;
}

export function presentGitFacet(change: GitFileChange | undefined): GitFacetPresentation | null {
  if (!change) return null;
  if (change.conflict) return { mark: "!", label: `conflict ${change.conflict.code}` };
  if (change.untracked) return { mark: "U", label: "Untracked — not yet added to Git" };
  if (change.staged && change.unstaged) return { mark: "±", label: "staged and unstaged changes" };
  if (change.staged) return { mark: "S", label: `staged ${change.staged.kind}` };
  if (change.unstaged) return { mark: "M", label: `unstaged ${change.unstaged.kind}` };
  return null;
}
