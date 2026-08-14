// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  compactAge,
  groupSessionsByCwd,
  splitNavSections,
  type NavCuration,
} from "../../src/components/Nav";
import { sessionSummary } from "./helpers";

const curation = (overrides: Partial<NavCuration> = {}): NavCuration => ({
  pinnedSessionIds: [],
  pinnedProjectCwds: [],
  hiddenProjectCwds: [],
  hiddenSessionIds: [],
  ...overrides,
});

describe("groupSessionsByCwd", () => {
  it("groups by exact cwd; groups sort by newest session, sessions by modified", () => {
    const a1 = sessionSummary({
      id: "a1",
      cwd: "/home/u/alpha",
      project: "alpha",
      modified: "2026-07-20T10:00:00Z",
    });
    const a2 = sessionSummary({
      id: "a2",
      cwd: "/home/u/alpha",
      project: "alpha",
      modified: "2026-07-22T10:00:00Z",
    });
    const b1 = sessionSummary({
      id: "b1",
      cwd: "/home/u/beta",
      project: "beta",
      modified: "2026-07-21T10:00:00Z",
    });
    const groups = groupSessionsByCwd([a1, b1, a2]);
    expect(groups.map((group) => group.cwd)).toEqual([
      "/home/u/alpha",
      "/home/u/beta",
    ]);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual([
      "a2",
      "a1",
    ]);
    expect(groups[1]!.sessions.map((session) => session.id)).toEqual(["b1"]);
  });

  it("treats similar but distinct folders as separate groups", () => {
    const x = sessionSummary({ id: "x", cwd: "/home/u/app" });
    const y = sessionSummary({ id: "y", cwd: "/home/u/app2" });
    expect(
      groupSessionsByCwd([x, y])
        .map((group) => group.cwd)
        .sort(),
    ).toEqual(["/home/u/app", "/home/u/app2"]);
  });

  it("groups a search-filtered subset the same way", () => {
    // Search results arrive already filtered by the host; grouping is identical.
    const a1 = sessionSummary({
      id: "a1",
      title: "fix parser",
      cwd: "/home/u/alpha",
      modified: "2026-07-20T10:00:00Z",
    });
    const b1 = sessionSummary({
      id: "b1",
      title: "fix build",
      cwd: "/home/u/beta",
      modified: "2026-07-22T10:00:00Z",
    });
    const groups = groupSessionsByCwd([a1, b1]);
    expect(groups.map((group) => group.cwd)).toEqual([
      "/home/u/beta",
      "/home/u/alpha",
    ]);
    expect(groups.every((group) => group.sessions.length === 1)).toBe(true);
  });

  it("returns no groups for an empty list", () => {
    expect(groupSessionsByCwd([])).toEqual([]);
  });
});

describe("splitNavSections", () => {
  it("collects pinned sessions across projects, newest activity first", () => {
    const a = sessionSummary({
      id: "a",
      cwd: "/home/u/alpha",
      modified: "2026-07-20T10:00:00Z",
    });
    const b = sessionSummary({
      id: "b",
      cwd: "/home/u/beta",
      modified: "2026-07-22T10:00:00Z",
    });
    const c = sessionSummary({
      id: "c",
      cwd: "/home/u/alpha",
      modified: "2026-07-21T10:00:00Z",
    });
    const { pinned, groups } = splitNavSections(
      [a, c, b],
      curation({ pinnedSessionIds: ["a", "b"] }),
    );
    expect(pinned.map((session) => session.id)).toEqual(["b", "a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual(["c"]);
  });

  it("never duplicates a pinned session into its cwd group", () => {
    const pinnedSession = sessionSummary({ id: "p", cwd: "/home/u/alpha" });
    const other = sessionSummary({ id: "o", cwd: "/home/u/alpha" });
    const { pinned, groups } = splitNavSections(
      [pinnedSession, other],
      curation({ pinnedSessionIds: ["p"] }),
    );
    expect(pinned.map((session) => session.id)).toEqual(["p"]);
    const groupedIds = groups.flatMap((group) =>
      group.sessions.map((session) => session.id),
    );
    expect(groupedIds).not.toContain("p");
    expect(groupedIds).toEqual(["o"]);
  });

  it("returns an empty Pinned section when nothing is pinned and empty groups when all are pinned", () => {
    const plain = sessionSummary({ id: "x" });
    expect(splitNavSections([plain], curation()).pinned).toEqual([]);
    const only = sessionSummary({ id: "y" });
    expect(
      splitNavSections([only], curation({ pinnedSessionIds: ["y"] })).groups,
    ).toEqual([]);
  });

  it("keeps pinned matches in the Pinned section for a search-filtered subset", () => {
    // Search results arrive host-filtered; splitting must not re-file them.
    const pinnedMatch = sessionSummary({
      id: "pm",
      title: "fix parser",
      cwd: "/a",
    });
    const plainMatch = sessionSummary({
      id: "xm",
      title: "fix parser too",
      cwd: "/a",
    });
    const { pinned, groups } = splitNavSections(
      [pinnedMatch, plainMatch],
      curation({ pinnedSessionIds: ["pm"] }),
    );
    expect(pinned.map((session) => session.id)).toEqual(["pm"]);
    expect(
      groups.flatMap((group) => group.sessions.map((session) => session.id)),
    ).toEqual(["xm"]);
  });

  it("lifts pinned folders out of the ordinary groups, keeping their own order", () => {
    const old = sessionSummary({
      id: "old",
      cwd: "/home/u/archive",
      modified: "2026-07-01T10:00:00Z",
    });
    const fresh = sessionSummary({
      id: "fresh",
      cwd: "/home/u/active",
      modified: "2026-07-25T10:00:00Z",
    });
    const { pinnedGroups, groups } = splitNavSections(
      [fresh, old],
      curation({ pinnedProjectCwds: ["/home/u/archive"] }),
    );
    expect(pinnedGroups.map((group) => group.cwd)).toEqual(["/home/u/archive"]);
    expect(groups.map((group) => group.cwd)).toEqual(["/home/u/active"]);
  });

  it("files an entire hidden folder once and keeps individual Hidden independent", () => {
    const first = sessionSummary({
      id: "a",
      cwd: "/home/u/hidden",
      modified: "2026-07-22T10:00:00Z",
    });
    const second = sessionSummary({
      id: "b",
      cwd: "/home/u/hidden",
      modified: "2026-07-21T10:00:00Z",
    });
    const individuallyHidden = sessionSummary({
      id: "c",
      cwd: "/home/u/visible",
    });
    const sections = splitNavSections(
      [second, individuallyHidden, first],
      curation({
        hiddenProjectCwds: ["/home/u/hidden"],
        hiddenSessionIds: ["b", "c"],
        pinnedSessionIds: ["a"],
        pinnedProjectCwds: ["/home/u/hidden"],
      }),
    );
    expect(sections.hiddenGroups).toHaveLength(1);
    expect(
      sections.hiddenGroups[0]!.sessions.map((session) => session.id),
    ).toEqual(["a", "b"]);
    expect(sections.hidden.map((session) => session.id)).toEqual(["c"]);
    expect(sections.pinned).toEqual([]);
    expect(sections.pinnedGroups).toEqual([]);
    expect(sections.groups).toEqual([]);
  });

  it("files a hidden session under Hidden even when its folder or the session itself is pinned", () => {
    const hidden = sessionSummary({ id: "h", cwd: "/home/u/alpha" });
    const kept = sessionSummary({ id: "k", cwd: "/home/u/alpha" });
    const sections = splitNavSections(
      [hidden, kept],
      // Preferences keep pin and hidden exclusive; a hand-edited file that
      // breaks that must still file the session exactly once.
      curation({
        hiddenSessionIds: ["h"],
        pinnedSessionIds: ["h"],
        pinnedProjectCwds: ["/home/u/alpha"],
      }),
    );
    expect(sections.hidden.map((session) => session.id)).toEqual(["h"]);
    expect(sections.pinned).toEqual([]);
    expect(
      sections.pinnedGroups.flatMap((group) => group.sessions.map((s) => s.id)),
    ).toEqual(["k"]);
    expect(sections.groups).toEqual([]);
  });
});

describe("compactAge", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");

  it("compresses recency to one unit and falls back to a short date", () => {
    expect(compactAge("2026-07-27T11:59:30Z", now)).toBe("now");
    expect(compactAge("2026-07-27T11:48:00Z", now)).toBe("12m");
    expect(compactAge("2026-07-27T09:00:00Z", now)).toBe("3h");
    expect(compactAge("2026-07-22T12:00:00Z", now)).toBe("5d");
    expect(compactAge("2026-01-03T12:00:00Z", now)).toMatch(/\d/);
  });

  it("reads empty for an unparseable timestamp and never goes negative", () => {
    expect(compactAge("not a date", now)).toBe("");
    expect(compactAge("2026-07-27T12:05:00Z", now)).toBe("now");
  });
});
