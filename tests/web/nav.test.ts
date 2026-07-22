// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { groupSessionsByCwd, splitNavSections } from "../../src/components/Nav";
import { sessionSummary } from "./helpers";

describe("groupSessionsByCwd", () => {
  it("groups by exact cwd; groups sort by newest session, sessions by modified", () => {
    const a1 = sessionSummary({ id: "a1", cwd: "/home/u/alpha", project: "alpha", modified: "2026-07-20T10:00:00Z" });
    const a2 = sessionSummary({ id: "a2", cwd: "/home/u/alpha", project: "alpha", modified: "2026-07-22T10:00:00Z" });
    const b1 = sessionSummary({ id: "b1", cwd: "/home/u/beta", project: "beta", modified: "2026-07-21T10:00:00Z" });
    const groups = groupSessionsByCwd([a1, b1, a2]);
    expect(groups.map((group) => group.cwd)).toEqual(["/home/u/alpha", "/home/u/beta"]);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual(["a2", "a1"]);
    expect(groups[1]!.sessions.map((session) => session.id)).toEqual(["b1"]);
  });

  it("treats similar but distinct folders as separate groups", () => {
    const x = sessionSummary({ id: "x", cwd: "/home/u/app" });
    const y = sessionSummary({ id: "y", cwd: "/home/u/app2" });
    expect(groupSessionsByCwd([x, y]).map((group) => group.cwd).sort()).toEqual(["/home/u/app", "/home/u/app2"]);
  });

  it("groups a search-filtered subset the same way", () => {
    // Search results arrive already filtered by the host; grouping is identical.
    const a1 = sessionSummary({ id: "a1", title: "fix parser", cwd: "/home/u/alpha", modified: "2026-07-20T10:00:00Z" });
    const b1 = sessionSummary({ id: "b1", title: "fix build", cwd: "/home/u/beta", modified: "2026-07-22T10:00:00Z" });
    const groups = groupSessionsByCwd([a1, b1]);
    expect(groups.map((group) => group.cwd)).toEqual(["/home/u/beta", "/home/u/alpha"]);
    expect(groups.every((group) => group.sessions.length === 1)).toBe(true);
  });

  it("returns no groups for an empty list", () => {
    expect(groupSessionsByCwd([])).toEqual([]);
  });
});

describe("splitNavSections", () => {
  it("collects pinned sessions across projects, newest activity first", () => {
    const a = sessionSummary({ id: "a", cwd: "/home/u/alpha", pinned: true, modified: "2026-07-20T10:00:00Z" });
    const b = sessionSummary({ id: "b", cwd: "/home/u/beta", pinned: true, modified: "2026-07-22T10:00:00Z" });
    const c = sessionSummary({ id: "c", cwd: "/home/u/alpha", modified: "2026-07-21T10:00:00Z" });
    const { pinned, groups } = splitNavSections([a, c, b]);
    expect(pinned.map((session) => session.id)).toEqual(["b", "a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual(["c"]);
  });

  it("never duplicates a pinned session into its cwd group", () => {
    const pinnedSession = sessionSummary({ id: "p", cwd: "/home/u/alpha", pinned: true });
    const other = sessionSummary({ id: "o", cwd: "/home/u/alpha" });
    const { pinned, groups } = splitNavSections([pinnedSession, other]);
    expect(pinned.map((session) => session.id)).toEqual(["p"]);
    const groupedIds = groups.flatMap((group) => group.sessions.map((session) => session.id));
    expect(groupedIds).not.toContain("p");
    expect(groupedIds).toEqual(["o"]);
  });

  it("returns an empty Pinned section when nothing is pinned and empty groups when all are pinned", () => {
    const plain = sessionSummary({ id: "x" });
    expect(splitNavSections([plain]).pinned).toEqual([]);
    const only = sessionSummary({ id: "y", pinned: true });
    expect(splitNavSections([only]).groups).toEqual([]);
  });

  it("keeps pinned matches in the Pinned section for a search-filtered subset", () => {
    // Search results arrive host-filtered; splitting must not re-file them.
    const pinnedMatch = sessionSummary({ id: "pm", title: "fix parser", cwd: "/a", pinned: true });
    const plainMatch = sessionSummary({ id: "xm", title: "fix parser too", cwd: "/a" });
    const { pinned, groups } = splitNavSections([pinnedMatch, plainMatch]);
    expect(pinned.map((session) => session.id)).toEqual(["pm"]);
    expect(groups.flatMap((group) => group.sessions.map((session) => session.id))).toEqual(["xm"]);
  });
});
