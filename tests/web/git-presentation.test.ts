import { describe, expect, it } from "vitest";
import type { GitFileChange, GitStatusResponse } from "../../shared/contracts";
import {
  gitDecorationForChange,
  gitDecorationForDirectory,
} from "../../src/git-presentation";

function change(overrides: Partial<GitFileChange>, workspacePath = "a/b.md"): GitFileChange {
  return {
    path: { id: "x", display: workspacePath, workspacePath },
    untracked: false,
    ...overrides,
  };
}

function statusWith(files: GitFileChange[]): Extract<GitStatusResponse, { kind: "repository" }> {
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
    expect(gitDecorationForChange(change({ conflict: { code: "UU" } }))).toBe("conflict");
    expect(gitDecorationForChange(change({ untracked: true }))).toBe("untracked");
    expect(gitDecorationForChange(change({ staged: { kind: "modified" } }))).toBe("modified");
    expect(gitDecorationForChange(change({ unstaged: { kind: "modified" } }))).toBe("modified");
    expect(gitDecorationForChange(change({}))).toBeNull();
  });
});

describe("gitDecorationForDirectory", () => {
  it("returns null outside a repository or without matching descendants", () => {
    expect(gitDecorationForDirectory(null, "projects")).toBeNull();
    expect(gitDecorationForDirectory({ kind: "not-repository" }, "projects")).toBeNull();
    expect(gitDecorationForDirectory(statusWith([change({ untracked: true }, "other/x.md")]), "projects")).toBeNull();
  });

  it("rolls up the most severe descendant state (conflict > modified > untracked)", () => {
    const status = statusWith([
      change({ untracked: true }, "projects/a/new.md"),
      change({ unstaged: { kind: "modified" } }, "projects/a/touched.md"),
    ]);
    expect(gitDecorationForDirectory(status, "projects")).toBe("modified");
    expect(gitDecorationForDirectory(status, "projects/a")).toBe("modified");
    // Git represents a changed submodule by the directory path itself.
    expect(gitDecorationForDirectory(
      statusWith([change({ unstaged: { kind: "modified" } }, "vendor/module")]),
      "vendor/module",
    )).toBe("modified");

    const withConflict = statusWith([
      change({ untracked: true }, "projects/a/new.md"),
      change({ unstaged: { kind: "modified" } }, "projects/a/touched.md"),
      change({ conflict: { code: "UU" } }, "projects/deep/clash.md"),
    ]);
    expect(gitDecorationForDirectory(withConflict, "projects")).toBe("conflict");
  });

  it("scopes by path prefix boundary and requires a safe workspace projection", () => {
    const status = statusWith([
      change({ unstaged: { kind: "modified" } }, "projects2/twin.md"),
      { path: { id: "y", display: "projects/lost.md" }, untracked: true },
    ]);
    expect(gitDecorationForDirectory(status, "projects")).toBeNull();
    expect(gitDecorationForDirectory(status, "projects2")).toBe("modified");
  });
});
