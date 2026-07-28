import { describe, expect, it } from "vitest";
import { newestPerCwd, type SessionRecord } from "../../server/session-catalog.js";

function record(id: string, cwd: string, modified: string): SessionRecord {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date(modified),
    messageCount: 1,
    firstMessage: id,
    searchText: id,
  };
}

describe("newestPerCwd", () => {
  const sessions = [
    record("other", "/work/other", "2026-07-27T10:00:00Z"),
    record("beta-old", "/work/beta", "2026-02-01T10:00:00Z"),
    record("alpha-mid", "/work/alpha", "2026-05-01T10:00:00Z"),
    record("alpha-new", "/work/alpha", "2026-07-01T10:00:00Z"),
    record("alpha-old", "/work/alpha", "2026-01-01T10:00:00Z"),
  ];

  it("answers with each named folder's sessions, newest first", () => {
    // The catalog's own order is not assumed: a folder pin has to produce the
    // folder's newest work whatever order the session tree was listed in.
    expect(newestPerCwd(sessions, ["/work/alpha", "/work/beta"], 40).map((session) => session.id)).toEqual([
      "alpha-new",
      "alpha-mid",
      "beta-old",
      "alpha-old",
    ]);
  });

  it("bounds each folder independently rather than the answer as a whole", () => {
    expect(newestPerCwd(sessions, ["/work/alpha", "/work/beta"], 1).map((session) => session.id)).toEqual([
      "alpha-new",
      "beta-old",
    ]);
  });

  it("returns nothing when no folder is pinned", () => {
    expect(newestPerCwd(sessions, [], 40)).toEqual([]);
  });
});
