import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { piInstallation, SessionManager } from "../../server/pi-runtime.js";
import {
  newestPerCwd,
  orderSessionRecords,
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";
import { searchSessionRecords } from "../../server/session-search.js";

function record(id: string, cwd: string, modified: string): SessionRecord {
  return {
    path: `/sessions/${id}.jsonl`,
    source: null,
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

  it("hydrates complete curated folders beyond the chronological page size", async () => {
    const rows = Array.from({ length: 41 }, (_, index) =>
      record(`session-${index}`, "/work/curated", "2026-07-01T10:00:00Z"),
    );
    const catalog = new SessionCatalog("/unused", {
      list: async () => rows,
    });

    await expect(catalog.listByCwds(["/work/curated"])).resolves.toHaveLength(
      41,
    );
  });

  it("reports offset, bounded limit, and total independently from page length", async () => {
    const catalog = new SessionCatalog("/unused");
    const rows = orderSessionRecords([
      record("match-old", "/work/a", "2026-07-01T10:00:00Z"),
      record("other", "/work/a", "2026-07-03T10:00:00Z"),
      record("match-new", "/work/a", "2026-07-02T10:00:00Z"),
    ]);
    vi.spyOn(catalog, "refresh").mockResolvedValue(rows);

    const page = await catalog.list({ offset: 1, limit: 1000 });
    expect(page).toMatchObject({ total: 3, offset: 1, limit: 100 });
    expect(page.sessions.map((session) => session.id)).toEqual([
      "match-new",
      "match-old",
    ]);
  });
});

async function withSearchFixture(
  run: (
    root: string,
    index: SessionMetadataIndex,
    catalog: SessionCatalog,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "inspire-session-search-"));
  const writeSession = async (
    id: string,
    day: number,
    messages: unknown[],
    name?: string,
  ) => {
    const time = `2026-10-0${day}T00:00:00.000Z`;
    await writeFile(
      join(root, `${id}.jsonl`),
      [
        {
          type: "session",
          version: 3,
          id,
          cwd: "/work/quantum-project",
          timestamp: time,
        },
        ...(name
          ? [
              {
                type: "session_info",
                id: "name",
                name,
                parentId: null,
                timestamp: time,
              },
            ]
          : []),
        ...messages.map((message, position) => ({
          type: "message",
          id: `m${position}`,
          parentId: position ? `m${position - 1}` : null,
          timestamp: time,
          message,
        })),
        {
          type: "compaction",
          id: "c",
          parentId: "m1",
          timestamp: time,
          firstKeptEntryId: "missing",
          summary: "Archived context",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  };
  await writeSession(
    "search-owner",
    2,
    [
      { role: "user", content: "a".repeat(12_000) + " first-body-tail" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "NEVER_INDEX_REASONING" },
          { type: "text", text: "assistant-only cobalt" },
          { type: "text", text: "exact\n retained\tphrase" },
        ],
      },
      { role: "user", content: 'later-only zirconium and quote "retained' },
      { role: "toolResult", content: "NEVER_INDEX_TOOL_OUTPUT" },
      { role: "custom", content: "NEVER_INDEX_EXTENSION_CONTENT" },
    ],
    "Quantum migration review",
  );
  await writeSession(
    "search-newer",
    3,
    [{ role: "user", content: "cobalt body" }],
    "Another review",
  );
  await writeSession("unrelated", 1, [
    { role: "user", content: "nothing relevant" },
  ]);
  const index = new SessionMetadataIndex();
  const catalog = new SessionCatalog("/unused", {
    list: () => index.list(root),
  });
  try {
    await run(root, index, catalog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("catalog retained-content search", () => {
  it("matches native query forms over complete retained user/assistant text, with chronological pages and bounded listings", async () => {
    await withSearchFixture(async (root, index, catalog) => {
      const native = await import(
        pathToFileURL(
          join(
            piInstallation.packageRoot,
            "dist/modes/interactive/components/session-selector-search.js",
          ),
        ).href
      );
      const nativeRows = await SessionManager.list(
        "/work/quantum-project",
        root,
      );
      const queries = [
        "first-body-tail",
        "later-only",
        "assistant-only",
        "search-owner",
        "/work/quantum-project",
        "Qmgrv",
        "zirconium cobalt",
        '"exact retained phrase"',
        '"cobalt exact"',
        "re:assistant-only.*cobalt",
        "re:SEARCH-OWNER",
        "re:Quantum.*zirconium",
        "re:[",
        "re:",
        '"retained',
        '"NEVER_INDEX_TOOL_OUTPUT"',
        '"NEVER_INDEX_REASONING"',
        '"NEVER_INDEX_EXTENSION_CONTENT"',
      ];
      for (const query of queries) {
        const page = await catalog.list({ query });
        expect(
          page.sessions.map((session) => session.id),
          query,
        ).toEqual(
          native
            .filterAndSortSessions(nativeRows, query, "recent")
            .map((session: { id: string }) => session.id),
        );
      }
      expect(
        (await catalog.list({ query: '"exact retained phrase"' })).sessions.map(
          (session) => session.id,
        ),
      ).toEqual(["search-owner"]);
      const first = await catalog.list({ query: "cobalt", limit: 1 });
      const second = await catalog.list({
        query: "cobalt",
        limit: 1,
        offset: 1,
      });
      expect(first).toMatchObject({
        total: 2,
        offset: 0,
        sessions: [{ id: "search-newer" }],
      });
      expect(second).toMatchObject({
        total: 2,
        offset: 1,
        sessions: [{ id: "search-owner" }],
      });
      const summaries = await index.list(root);
      expect(
        summaries.find((row) => row.id === "search-owner")?.firstMessage,
      ).toHaveLength(10_000);
      expect(
        summaries.every((row) => !Object.hasOwn(row, "allMessagesText")),
      ).toBe(true);
      expect(JSON.stringify((await catalog.list()).sessions)).not.toContain(
        "assistant-only",
      );
    });
  }, 30_000);

  it("searches a growing session's complete prefix, retires cancellation, and refuses replaced identity", async () => {
    await withSearchFixture(async (root, index) => {
      const records = await index.list(root);
      const controller = new AbortController();
      const searching = searchSessionRecords(
        records,
        "re:(a+)+$",
        controller.signal,
      );
      controller.abort();
      await expect(searching).rejects.toMatchObject({ name: "AbortError" });
      const growingPath = join(root, "growing.jsonl");
      await writeFile(
        growingPath,
        [
          { type: "session", version: 3, id: "growing", cwd: "/work/growing" },
          ...Array.from({ length: 25 }, (_, id) => ({
            type: "message",
            id: `long-${id}`,
            message: {
              role: "user",
              content: "complete-prefix-target " + "x".repeat(200_000),
            },
          })),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const growing = (await index.list(root)).find(
        (row) => row.id === "growing",
      )!;
      let writing = true;
      let appended = 0;
      const writer = (async () => {
        while (writing) {
          await appendFile(
            growingPath,
            `${JSON.stringify({ type: "message", id: `live-${appended++}`, message: { role: "assistant", content: "new response text" } })}\n`,
          );
          await delay(2);
        }
      })();
      try {
        expect(
          (
            await searchSessionRecords([growing], '"complete-prefix-target"')
          ).map((row) => row.id),
        ).toEqual(["growing"]);
        expect(appended).toBeGreaterThan(1);
      } finally {
        writing = false;
        await writer;
      }
      // A same-size in-place rewrite is not a preserved prefix, unlike append.
      const position = (await readFile(growingPath)).indexOf(
        "complete-prefix-target",
      );
      const handle = await open(growingPath, "r+");
      let rewriting = true;
      const rewriter = (async () => {
        while (rewriting) {
          await handle.write("C", position, "utf8");
          await delay(2);
        }
      })();
      try {
        await expect(
          searchSessionRecords([growing], '"complete-prefix-target"'),
        ).rejects.toThrow(/source changed/i);
      } finally {
        rewriting = false;
        await rewriter;
        await handle.close();
      }
      const owner = records.find((row) => row.id === "search-owner")!;
      await rm(owner.path);
      await writeFile(
        owner.path,
        `${JSON.stringify({ type: "session", version: 3, id: "replacement", cwd: owner.cwd })}\n`,
      );
      await expect(
        searchSessionRecords([owner], "replacement"),
      ).rejects.toThrow(/source changed/i);
    });
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
