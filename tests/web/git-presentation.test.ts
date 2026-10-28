import { describe, expect, it } from "vitest";
import type { GitFileChange, GitStatusResponse } from "../../shared/contracts";
import {
  gitDecorationForChange,
  gitDecorationForDirectory,
  presentGitFacet,
} from "../../src/git-presentation";

function change(
  overrides: Partial<GitFileChange>,
  workspacePath = "a/b.md",
): GitFileChange {
  return {
    path: { id: "x", display: workspacePath, workspacePath },
    untracked: false,
    ...overrides,
  };
}

function statusWith(
  files: GitFileChange[],
): Extract<GitStatusResponse, { kind: "repository" }> {
  return {
    kind: "repository",
    head: { kind: "branch", name: "main", oid: "abc" },
    files,
    groups: { conflicted: [], staged: [], unstaged: [], untracked: [] },
    total: files.length,
    truncated: false,
  };
}

describe("gitDecorationForChange", () => {
  it("maps facets to decoration severity", () => {
    expect(gitDecorationForChange(undefined)).toBeNull();
    expect(gitDecorationForChange(change({ conflict: { code: "UU" } }))).toBe(
      "conflict",
    );
    expect(gitDecorationForChange(change({ untracked: true }))).toBe(
      "untracked",
    );
    expect(
      gitDecorationForChange(change({ worktree: { kind: "deleted" } })),
    ).toBe("modified");
    expect(
      gitDecorationForChange(change({ worktree: { kind: "modified" } })),
    ).toBe("modified");
    expect(gitDecorationForChange(change({}))).toBeNull();
  });
});

describe("presentGitFacet", () => {
  it("uses only the net facet even when index and working-tree facets disagree", () => {
    const file = change({
      staged: { kind: "added" },
      unstaged: { kind: "deleted" },
    });
    expect(presentGitFacet(file)).toBeNull();
    expect(gitDecorationForChange(file)).toBeNull();
    expect(
      presentGitFacet({ ...file, worktree: { kind: "modified" } }),
    ).toEqual({ mark: "M", label: "modified" });
  });
  it.each([
    ["added", "A"],
    ["modified", "M"],
    ["deleted", "D"],
    ["renamed", "R"],
    ["copied", "C"],
    ["type-changed", "T"],
  ] as const)("presents net %s as %s", (kind, mark) => {
    expect(presentGitFacet(change({ worktree: { kind } }))).toEqual({
      mark,
      label: kind,
    });
  });
  it("keeps conflict and untracked provenance clear", () => {
    expect(
      presentGitFacet(
        change({ conflict: { code: "UU" }, worktree: { kind: "unmerged" } }),
      ),
    ).toEqual({ mark: "!", label: "conflict UU" });
    expect(
      presentGitFacet(change({ untracked: true, worktree: { kind: "added" } })),
    ).toEqual({ mark: "U", label: "Untracked — not yet added to Git" });
  });
});

describe("gitDecorationForDirectory", () => {
  it("returns null outside a repository or without matching descendants", () => {
    expect(gitDecorationForDirectory(null, "projects")).toBeNull();
    expect(
      gitDecorationForDirectory({ kind: "not-repository" }, "projects"),
    ).toBeNull();
    expect(
      gitDecorationForDirectory(
        statusWith([change({ untracked: true }, "other/x.md")]),
        "projects",
      ),
    ).toBeNull();
  });

  it("rolls up the most severe descendant state (conflict > modified > untracked)", () => {
    const status = statusWith([
      change({ untracked: true }, "projects/a/new.md"),
      change({ worktree: { kind: "modified" } }, "projects/a/touched.md"),
    ]);
    expect(gitDecorationForDirectory(status, "projects")).toBe("modified");
    expect(gitDecorationForDirectory(status, "projects/a")).toBe("modified");
    // Git represents a changed submodule by the directory path itself.
    expect(
      gitDecorationForDirectory(
        statusWith([
          change({ worktree: { kind: "modified" } }, "vendor/module"),
        ]),
        "vendor/module",
      ),
    ).toBe("modified");

    const withConflict = statusWith([
      change({ untracked: true }, "projects/a/new.md"),
      change({ worktree: { kind: "modified" } }, "projects/a/touched.md"),
      change({ conflict: { code: "UU" } }, "projects/deep/clash.md"),
    ]);
    expect(gitDecorationForDirectory(withConflict, "projects")).toBe(
      "conflict",
    );
  });

  it("scopes by path prefix boundary and requires a safe workspace projection", () => {
    const status = statusWith([
      change({ worktree: { kind: "modified" } }, "projects2/twin.md"),
      { path: { id: "y", display: "projects/lost.md" }, untracked: true },
    ]);
    expect(gitDecorationForDirectory(status, "projects")).toBeNull();
    expect(gitDecorationForDirectory(status, "projects2")).toBe("modified");
  });
});
