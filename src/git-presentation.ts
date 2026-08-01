import type { GitFileChange } from "../shared/contracts";

export interface GitFacetPresentation { mark: string; label: string }

export function presentGitFacet(change: GitFileChange | undefined): GitFacetPresentation | null {
  if (!change) return null;
  if (change.conflict) return { mark: "!", label: `conflict ${change.conflict.code}` };
  if (change.untracked) return { mark: "U", label: "Untracked — not yet added to Git" };
  if (change.staged && change.unstaged) return { mark: "±", label: "staged and unstaged changes" };
  if (change.staged) return { mark: "S", label: `staged ${change.staged.kind}` };
  if (change.unstaged) return { mark: "M", label: `unstaged ${change.unstaged.kind}` };
  return null;
}
