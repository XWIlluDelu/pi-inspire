import { describe, expect, it, vi } from "vitest";
import {
  newestPerCwd,
  orderSessionRecords,
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";

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

describe("catalog identity and pagination", () => {
  it("isolates duplicate Pi ids instead of displaying one path and opening another", async () => {
    const duplicateNew = record(
      "duplicate",
      "/work/new",
      "2026-07-03T10:00:00Z",
    );
    duplicateNew.path = "/sessions/new.jsonl";
    const duplicateOld = record(
      "duplicate",
      "/work/old",
      "2026-07-01T10:00:00Z",
    );
    duplicateOld.path = "/sessions/old.jsonl";
    const unique = record("unique", "/work/unique", "2026-07-02T10:00:00Z");
    unique.parentSessionPath = duplicateNew.path;
    const catalog = new SessionCatalog("/unused", {
      list: async () => [duplicateOld, unique, duplicateNew],
    });

    expect(
      (await catalog.list()).sessions.map((session) => session.id),
    ).toEqual(["unique"]);
    await expect(catalog.get("duplicate")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/ambiguous/i),
    });
    await expect(catalog.listByIds(["duplicate"])).rejects.toMatchObject({
      status: 409,
    });
    expect((await catalog.list()).sessions[0]).not.toHaveProperty(
      "parentSessionId",
    );
  });

  it("rescans an invalidated ambiguous id so repaired storage can recover", async () => {
    const duplicateNew = record(
      "duplicate",
      "/work/new",
      "2026-07-03T10:00:00Z",
    );
    duplicateNew.path = "/sessions/new.jsonl";
    const duplicateOld = record(
      "duplicate",
      "/work/old",
      "2026-07-01T10:00:00Z",
    );
    duplicateOld.path = "/sessions/old.jsonl";
    const list = vi
      .fn<() => Promise<SessionRecord[]>>()
      .mockResolvedValueOnce([duplicateOld, duplicateNew])
      .mockResolvedValueOnce([duplicateNew]);
    const catalog = new SessionCatalog("/unused", { list });

    await expect(catalog.get("duplicate")).rejects.toMatchObject({
      status: 409,
    });
    catalog.invalidate();

    await expect(catalog.get("duplicate")).resolves.toBe(duplicateNew);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("uses deterministic newest-first ordering with stable tie-breakers", () => {
    const sameTime = "2026-07-27T10:00:00Z";
    const old = record("old", "/work/a", "2026-07-01T10:00:00Z");
    const beta = record("beta", "/work/a", sameTime);
    const alpha = record("alpha", "/work/a", sameTime);
    expect(
      orderSessionRecords([old, beta, alpha]).map((session) => session.id),
    ).toEqual(["alpha", "beta", "old"]);
  });

  it("queues a new generation and never returns invalidated rows", async () => {
    const stale = record("stale", "/work/a", "2026-07-01T10:00:00Z");
    const fresh = record("fresh", "/work/a", "2026-07-02T10:00:00Z");
    const resolvers: Array<(rows: SessionRecord[]) => void> = [];
    const list = vi.fn(
      () =>
        new Promise<SessionRecord[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const catalog = new SessionCatalog("/unused", { list });

    const first = catalog.refresh();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    catalog.invalidate();
    const current = catalog.refresh();
    expect(list).toHaveBeenCalledTimes(1);

    resolvers[0]!([stale]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    resolvers[1]!([fresh]);

    await expect(first).resolves.toEqual([fresh]);
    await expect(current).resolves.toEqual([fresh]);
    await expect(catalog.refresh()).resolves.toEqual([fresh]);
  });

  it("makes a forced refresh a distinct ordered generation", async () => {
    const stale = record("stale", "/work/a", "2026-07-01T10:00:00Z");
    const fresh = record("fresh", "/work/a", "2026-07-02T10:00:00Z");
    const resolvers: Array<(rows: SessionRecord[]) => void> = [];
    const list = vi.fn(
      () =>
        new Promise<SessionRecord[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const catalog = new SessionCatalog("/unused", { list });

    const first = catalog.refresh();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const forced = catalog.refresh(true);
    expect(list).toHaveBeenCalledTimes(1);

    resolvers[0]!([stale]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    resolvers[1]!([fresh]);

    await expect(first).resolves.toEqual([fresh]);
    await expect(forced).resolves.toEqual([fresh]);
    await expect(catalog.list()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: "fresh" })],
    });
  });

  it("reports offset, bounded limit, and filtered total independently from page length", async () => {
    const catalog = new SessionCatalog("/unused");
    const rows = orderSessionRecords([
      record("match-old", "/work/a", "2026-07-01T10:00:00Z"),
      record("other", "/work/a", "2026-07-03T10:00:00Z"),
      record("match-new", "/work/a", "2026-07-02T10:00:00Z"),
    ]);
    rows[0]!.searchText = "other";
    rows[1]!.searchText = "match new";
    rows[2]!.searchText = "match old";
    vi.spyOn(catalog, "refresh").mockResolvedValue(rows);

    const page = await catalog.list({ query: "match", offset: 1, limit: 1000 });
    expect(page).toMatchObject({ total: 2, offset: 1, limit: 100 });
    expect(page.sessions.map((session) => session.id)).toEqual(["match-old"]);
  });
});

describe("catalog title provenance", () => {
  it("uses firstMessage as the public title when a session is unnamed", () => {
    const secret = "SECRET_PROMPT_DO_NOT_NOTIFY";
    const unnamed = record(
      "unnamed",
      "/safe/research-project",
      "2026-07-01T10:00:00Z",
    );
    unnamed.firstMessage = secret;
    unnamed.searchText = secret.toLowerCase();
    const summary = new SessionCatalog("/unused").project(unnamed);
    expect(summary.title).toBe(secret);
    expect(summary.project).toBe("research-project");
  });

  it("calls an empty conversation New session rather than Untitled session", () => {
    const empty = record(
      "empty",
      "/safe/research-project",
      "2026-07-01T10:00:00Z",
    );
    empty.firstMessage = "";
    empty.messageCount = 0;
    expect(new SessionCatalog("/unused").project(empty).title).toBe(
      "New session",
    );
  });
});

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
    expect(
      newestPerCwd(sessions, ["/work/alpha", "/work/beta"], 40).map(
        (session) => session.id,
      ),
    ).toEqual(["alpha-new", "alpha-mid", "beta-old", "alpha-old"]);
  });

  it("bounds each folder independently rather than the answer as a whole", () => {
    expect(
      newestPerCwd(sessions, ["/work/alpha", "/work/beta"], 1).map(
        (session) => session.id,
      ),
    ).toEqual(["alpha-new", "beta-old"]);
  });

  it("returns nothing when no folder is pinned", () => {
    expect(newestPerCwd(sessions, [], 40)).toEqual([]);
  });
});
