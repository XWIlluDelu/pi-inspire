import type {
  GitFileChange,
  GitStatusDetail,
  GitStatusResponse,
} from "../shared/contracts";

export function gitStatusDetail(
  status: GitStatusResponse | null,
): GitStatusDetail | null {
  return status?.kind === "repository" && !("files" in status) ? null : status;
}

interface GitFacetPresentation {
  mark: string;
  label: string;
}

/** Compact, user-facing repository identity shared by the topbar and context pane. */
export function gitHeadLabel(
  status: GitStatusResponse | null | undefined,
): string | null {
  if (status?.kind !== "repository") return null;
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
  if (change.worktree) {
    const marks = {
      added: "A",
      modified: "M",
      deleted: "D",
      renamed: "R",
      copied: "C",
      "type-changed": "T",
      unmerged: "!",
    };
    return { mark: marks[change.worktree.kind], label: change.worktree.kind };
  }
  return null;
}

/** State color for identifier lists (file trees). Kept separate from the
 * facet mark so the two channels stay independent: the letter says which
 * state, the hue only says how severe. `ignored` never decorates — an
 * ignored file is intentionally invisible, not a state to act on. */
type GitDecoration = "conflict" | "modified" | "untracked";

export function gitDecorationForChange(
  change: GitFileChange | undefined,
): GitDecoration | null {
  if (!change) return null;
  if (change.conflict) return "conflict";
  if (change.untracked) return "untracked";
  if (change.worktree) return "modified";
  return null;
}

/** A directory (including a submodule itself) takes its most severe change. */
export function workspaceGitChanges(status: GitStatusResponse | null) {
  const files = new Map<string, GitFileChange>();
  const directories = new Map<string, GitDecoration>();
  const detail = gitStatusDetail(status);
  if (detail?.kind === "repository") {
    for (const file of detail.files) {
      const path = file.path.workspacePath;
      if (!path) continue;
      files.set(path, file);
      const decoration = gitDecorationForChange(file);
      if (!decoration) continue;
      let dir = path;
      while (dir) {
        const previous = directories.get(dir);
        if (
          previous === decoration ||
          previous === "conflict" ||
          (previous === "modified" && decoration === "untracked")
        )
          break;
        directories.set(dir, decoration);
        const slash = dir.lastIndexOf("/");
        if (slash < 0) break;
        dir = dir.slice(0, slash);
      }
    }
  }
  return { files, directories };
}
