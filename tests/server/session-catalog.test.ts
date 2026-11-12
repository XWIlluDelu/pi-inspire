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
import { describe, expect, it, vi } from "vitest";
import {
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";
import { searchSessionRecords } from "../../server/session-search.js";
import {
  MAX_CURATED_SESSION_RESULTS,
  MAX_SESSION_DISPLAY_TITLE_CHARS,
} from "../../shared/contracts.js";

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
  };
}

describe("catalog identity and pagination", () => {
  it.each(["invalidation", "forced refresh"])(
    "queues %s as a new generation and returns only the current rows",
    async (reason) => {
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
      if (reason === "invalidation") catalog.invalidate();
      const current = catalog.refresh(reason === "forced refresh");
      expect(list).toHaveBeenCalledTimes(1);

      resolvers[0]!([stale]);
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      resolvers[1]!([fresh]);

      await expect(first).resolves.toEqual([fresh]);
      await expect(current).resolves.toEqual([fresh]);
      await expect(catalog.list()).resolves.toMatchObject({
        sessions: [{ id: "fresh" }],
      });
    },
  );

  it("pages newest-first with stable ties, a bounded limit, and an independent total", async () => {
    const sameTime = "2026-07-27T10:00:00Z";
    const catalog = new SessionCatalog("/unused", {
      list: async () => [
        record("beta", "/work/a", sameTime),
        record("old", "/work/a", "2026-07-01T10:00:00Z"),
        record("alpha", "/work/a", sameTime),
      ],
    });
    expect(await catalog.list({ limit: 1 })).toMatchObject({
      total: 3,
      sessions: [{ id: "alpha" }],
    });
    expect(await catalog.list({ offset: 1, limit: 1000 })).toMatchObject({
      total: 3,
      offset: 1,
      limit: 100,
      sessions: [{ id: "beta" }, { id: "old" }],
    });
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
          { type: "text", text: "**assistant-only** cobalt" },
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
    readCurrent: (session) => index.readCurrent(session),
  });
  try {
    await run(root, index, catalog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("catalog current metadata", () => {
  it("reuses a search across pages and observes invalidated sources", async () => {
    const searching = vi.spyOn(
      await import("../../server/session-search.js"),
      "searchSessionRecords",
    );
    try {
      await withSearchFixture(async (root, _index, catalog) => {
        const first = await catalog.list({ query: "cobalt", limit: 1 });
        const next = await catalog.list({
          query: "cobalt",
          offset: 1,
          limit: 1,
        });
        expect(first).toMatchObject({
          total: 2,
          offset: 0,
          sessions: [{ id: "search-newer", matchSnippet: "cobalt body" }],
        });
        expect(next).toMatchObject({
          total: 2,
          offset: 1,
          sessions: [{ id: "search-owner" }],
        });
        const snippet = next.sessions[0]!.matchSnippet;
        expect(snippet).toContain("cobalt");
        expect(snippet).not.toMatch(/\*\*|NEVER_INDEX/u);
        const again = await catalog.list({
          query: "cobalt",
          offset: 1,
          limit: 1,
        });
        expect(again.sessions[0]!.matchSnippet).toBe(snippet);
        expect(searching).toHaveBeenCalledOnce();
        await appendFile(
          join(root, "unrelated.jsonl"),
          JSON.stringify({
            type: "message",
            id: "new-match",
            parentId: "m1",
            timestamp: "2026-08-01T00:00:05.000Z",
            message: { role: "user", content: "cobalt", timestamp: 5 },
          }) + "\n",
        );
        catalog.invalidate();
        expect((await catalog.list({ query: "cobalt" })).total).toBe(3);
        expect(searching).toHaveBeenCalledTimes(2);
      });
    } finally {
      searching.mockRestore();
    }
  });

  it("refreshes renamed or cleared session titles and discards a replaced identity", async () => {
    await withSearchFixture(async (root, _index, catalog) => {
      expect((await catalog.get("search-owner"))?.name).toBe(
        "Quantum migration review",
      );
      const path = join(root, "search-owner.jsonl");
      await appendFile(
        path,
        JSON.stringify({
          type: "session_info",
          id: "renamed",
          name: "New saved name",
        }) + "\n",
      );
      expect((await catalog.get("search-owner", { refresh: true }))?.name).toBe(
        "New saved name",
      );
      await appendFile(
        path,
        JSON.stringify({
          type: "session_info",
          id: "cleared",
          name: "",
        }) + "\n",
      );
      expect(
        (await catalog.get("search-owner", { refresh: true }))?.name,
      ).toBeUndefined();
      await writeFile(
        path,
        JSON.stringify({
          type: "session",
          version: 3,
          id: "different-session",
          cwd: "/work/quantum-project",
          timestamp: "2026-10-02T00:00:00.000Z",
        }) + "\n",
      );
      expect(
        await catalog.get("search-owner", { refresh: true }),
      ).toBeUndefined();
    });
  });
});

describe("catalog retained-content search", () => {
  it("searches complete retained text with defined query syntax", async () => {
    await withSearchFixture(async (root, index, catalog) => {
      const cases: Array<[string, string[]]> = [
        ["first-body-tail", ["search-owner"]],
        ["later-only", ["search-owner"]],
        ["assistant-only", ["search-owner"]],
        ["search-owner", ["search-owner"]],
        [
          "/work/quantum-project",
          ["search-newer", "search-owner", "unrelated"],
        ],
        ["Qmgrv", ["search-owner"]],
        ["zirconium cobalt", ["search-owner"]],
        ['"exact retained phrase"', ["search-owner"]],
        ['"cobalt exact"', ["search-owner"]],
        ["re:assistant-only.*cobalt", ["search-owner"]],
        ["re:SEARCH-OWNER", ["search-owner"]],
        ["re:Quantum.*zirconium", ["search-owner"]],
        ["re:[", []],
        ["re:", []],
        ['"retained', []],
        ['"NEVER_INDEX_TOOL_OUTPUT"', []],
        ['"NEVER_INDEX_REASONING"', []],
        ['"NEVER_INDEX_EXTENSION_CONTENT"', []],
      ];
      for (const [query, expected] of cases) {
        const page = await catalog.list({ query });
        expect(
          page.sessions.map((session) => session.id),
          query,
        ).toEqual(expected);
      }
      const excerpt = (query: string) =>
        catalog.list({ query }).then((page) => page.sessions[0]?.matchSnippet);
      const late = await excerpt("first-body-tail");
      expect(late).toMatch(/^…[^…]{0,15}first-body-tail/u);
      expect(late!.length).toBeLessThanOrEqual(122);
      await expect(excerpt("Qmgrv")).resolves.toBeUndefined();
      await expect(excerpt("search-owner")).resolves.toBeUndefined();
      await expect(excerpt("zirconium cobalt")).resolves.toMatch(
        /^.{0,15}zirconium/u,
      );
      await expect(excerpt("re:assistant-only.*cobalt")).resolves.toContain(
        "assistant-only cobalt",
      );

      const summaries = await index.list(root);
      expect(
        summaries.find((row) => row.id === "search-owner")?.firstMessage,
      ).toHaveLength(MAX_SESSION_DISPLAY_TITLE_CHARS);
      expect(
        summaries.every((row) => !Object.hasOwn(row, "allMessagesText")),
      ).toBe(true);
      const browsing = await catalog.list();
      expect(browsing.sessions.every((row) => !row.matchSnippet)).toBe(true);
      expect(JSON.stringify(browsing.sessions)).not.toContain("assistant-only");
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

it("searches available sessions while identifying an unreadable or replaced source", async () => {
  await withSearchFixture(async (_root, _index, catalog) => {
    await catalog.list();
    const owner = await catalog.get("search-owner");
    await rm(owner!.path);
    await writeFile(
      owner!.path,
      `${JSON.stringify({ type: "session", version: 3, id: "replacement", cwd: owner!.cwd })}\n`,
    );
    const result = await catalog.list({ query: "cobalt" });
    expect(result.sessions.map((row) => row.id)).toEqual(["search-newer"]);
    expect(result.issues).toEqual([
      expect.objectContaining({ path: owner!.path }),
    ]);
  });
});

it("returns all requested folder sessions in catalog order or refuses the combined limit", async () => {
  const alpha = "/work/alpha";
  const beta = "/work/beta";
  const olderFolderRows = Array.from({ length: 40 }, (_, index) =>
    record(
      `alpha-${String(index).padStart(2, "0")}`,
      alpha,
      "2026-01-01T10:00:00Z",
    ),
  );
  const sessions = [
    record("beta-old", beta, "2026-02-01T10:00:00Z"),
    record("alpha-new", alpha, "2026-07-01T10:00:00Z"),
    ...olderFolderRows,
  ];
  const overflow = "/work/overflow";
  const catalog = new SessionCatalog("/unused", {
    list: async () => [
      ...sessions,
      ...Array.from({ length: MAX_CURATED_SESSION_RESULTS - 1 }, (_, index) =>
        record(`overflow-${index}`, overflow, "2026-02-01T10:00:00Z"),
      ),
    ],
  });

  const page = await catalog.list({ limit: 40 });
  expect(page.sessions.map((session) => session.id)).not.toContain("alpha-00");
  const curated = await catalog.listByCwds([beta, alpha, beta]);
  expect(curated.map((session) => session.id)).toEqual([
    "alpha-new",
    "beta-old",
    ...olderFolderRows.map((session) => session.id),
  ]);
  await expect(catalog.listByCwds([overflow, alpha])).rejects.toMatchObject({
    status: 413,
  });
});
