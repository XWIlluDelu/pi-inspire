// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installCatalog,
  type PageRequest,
  sessionPage,
} from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  jsonBody,
  sessionSummary,
} from "./helpers";
import { initStore } from "./store-fixture";

function pageFromIds(ids: string[], { offset, limit }: PageRequest) {
  return {
    body: sessionPage(
      ids.slice(offset, offset + limit).map((id) => sessionSummary({ id })),
      ids.length,
      offset,
      limit,
    ),
  };
}

describe("session list pagination", () => {
  beforeEach(() => installFakeWebSocket());
  afterEach(() => vi.useRealTimers());

  it("paginates by the server offset even with duplicate and curated rows", async () => {
    const offsets: number[] = [];
    const pages = [
      ["s0", "s1"],
      ["s1", "s2"],
      ["s3", "s4"],
    ];
    const pinned = sessionSummary({ id: "pinned" });
    const hidden = sessionSummary({ id: "hidden", cwd: "/work/hidden" });
    installCatalog(
      ({ offset }) => {
        offsets.push(offset);
        const sessions = pages[offset / 2]!.map((id) => sessionSummary({ id }));
        return { body: sessionPage(sessions, 6, offset) };
      },
      {
        preferences: {
          pinnedSessionIds: [pinned.id],
          hiddenProjectCwds: [hidden.cwd],
        },
        routes: (url) => {
          if (url.startsWith("/api/sessions/by-id"))
            return { body: { sessions: [pinned] } };
          if (url.startsWith("/api/sessions/by-cwd"))
            return { body: { sessions: [hidden] } };
        },
      },
    );
    const { store } = await initStore();
    const ids = () => store.getState().sessions.map(({ id }) => id);
    await vi.waitFor(() =>
      expect(ids()).toEqual(["s0", "s1", pinned.id, hidden.id]),
    );
    await store.loadOlderSessions();
    await store.loadOlderSessions();
    expect(offsets).toEqual([0, 2, 4]);
    expect(ids()).toEqual(["s0", "s1", "s2", "s3", "s4", pinned.id, hidden.id]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 6,
      sessionListTotal: 6,
    });
  });

  it("coalesces duplicate load-more requests and discards an old page after a query reset", async () => {
    const older = deferred<void>();
    let olderCalls = 0;
    installCatalog(async ({ query, offset }) => {
      if (query === "needle") {
        const id = offset === 0 ? "match" : "current-older";
        return { body: sessionPage([sessionSummary({ id })], 2, offset) };
      }
      if (offset === 0)
        return { body: sessionPage([sessionSummary({ id: "recent" })], 2) };
      olderCalls++;
      await older.promise;
      return {
        body: sessionPage([sessionSummary({ id: "stale-older" })], 2, 1),
      };
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(1),
    );

    const first = store.loadOlderSessions();
    const duplicate = store.loadOlderSessions();
    await vi.waitFor(() => expect(olderCalls).toBe(1));

    await store.loadSessions("needle");
    expect(store.getState()).toMatchObject({
      sessionQuery: "needle",
      sessionListNextOffset: 1,
      sessionListTotal: 2,
    });
    // The obsolete request still occupies the network, but cannot coalesce
    // with or block the current query's append.
    await store.loadOlderSessions();
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "match",
      "current-older",
    ]);
    older.resolve();
    await Promise.all([first, duplicate]);
    expect(olderCalls).toBe(1);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "match",
      "current-older",
    ]);
  });

  it.each(["older", "curation"])(
    "keeps an older page and curation hydration independent when %s finishes first",
    async (first) => {
      const olderGate = deferred<void>();
      const olderStarted = deferred<void>();
      const curationGate = deferred<void>();
      const curationStarted = deferred<void>();
      installCatalog(
        async ({ offset }) => {
          if (offset === 0)
            return { body: sessionPage([sessionSummary({ id: "recent" })], 2) };
          olderStarted.resolve();
          await olderGate.promise;
          return {
            body: sessionPage(
              [sessionSummary({ id: "older-page" })],
              2,
              offset,
            ),
          };
        },
        {
          routes: async (url, init) => {
            if (url === "/api/preferences")
              return {
                body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
              };
            if (url === "/api/sessions/by-id") {
              const { ids } = jsonBody(init) as { ids: string[] };
              curationStarted.resolve();
              await curationGate.promise;
              return {
                body: { sessions: ids.map((id) => sessionSummary({ id })) },
              };
            }
          },
        },
      );
      const { store } = await initStore();
      await vi.waitFor(() =>
        expect(store.getState().sessionListNextOffset).toBe(1),
      );

      const older = store.loadOlderSessions();
      await olderStarted.promise;
      store.toggleSessionPin("curated-outside-page");
      await curationStarted.promise;

      const finishCuration = async () => {
        curationGate.resolve();
        await vi.waitFor(() =>
          expect(
            store
              .getState()
              .sessions.some((row) => row.id === "curated-outside-page"),
          ).toBe(true),
        );
      };
      if (first === "curation") {
        await finishCuration();
        expect(store.getState().sessionListNextOffset).toBe(1);
      }
      olderGate.resolve();
      await older;
      if (first === "older") {
        expect(store.getState().sessionListHydrating).toBe(true);
        await finishCuration();
      }

      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "older-page",
        "curated-outside-page",
      ]);
      expect(store.getState().sessionListNextOffset).toBe(2);
    },
  );

  it("explicit refresh starts at offset zero, is latest-wins, and retains prior pages until replacement", async () => {
    const refresh = deferred<void>();
    let refreshing = false;
    const offsets: number[] = [];
    installCatalog(
      ({ offset }) => {
        offsets.push(offset);
        const id = refreshing ? "refreshed" : offset === 0 ? "recent" : "older";
        return {
          body: sessionPage(
            [sessionSummary({ id })],
            refreshing ? 1 : 2,
            offset,
          ),
        };
      },
      {
        routes: async (url) => {
          if (url !== "/api/sessions/refresh") return;
          refreshing = true;
          await refresh.promise;
          return { body: { ok: true } };
        },
      },
    );
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions[0]?.id).toBe("recent"),
    );
    await store.loadOlderSessions();
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "recent",
      "older",
    ]);

    const refreshingPromise = store.refreshSessions();
    await vi.waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(true),
    );
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "recent",
      "older",
    ]);
    refresh.resolve();
    await refreshingPromise;

    expect(offsets).toEqual([0, 1, 0]);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "refreshed",
    ]);
    expect(store.getState().sessionListNextOffset).toBe(1);
  });

  it("hydrates new and forked selections missing from the current catalog page", async () => {
    const created = activeSnapshot({
      sessionId: "new-session",
      cwd: "/work/new",
      effectiveLeafId: "leaf",
    });
    const forked = activeSnapshot({
      sessionId: "fork-session",
      cwd: "/work/fork",
    });
    const lookups: string[][] = [];
    installCatalog((page) => pageFromIds(["recent"], page), {
      routes: (url, init) => {
        if (url === "/api/sessions/new") return { body: created };
        if (url === "/api/branches/fork")
          return {
            body: {
              sessionId: "fork-session",
              snapshot: forked,
              editorText: "prompt",
            },
          };
        if (url === "/api/sessions/by-id") {
          const { ids } = jsonBody(init) as { ids: string[] };
          lookups.push(ids);
          return {
            body: { sessions: ids.map((id) => sessionSummary({ id })) },
          };
        }
      },
    });
    const { store } = await initStore();

    await store.newSession("/work/new");
    await vi.waitFor(() =>
      expect(store.getState().sessions.map(({ id }) => id)).toContain(
        "new-session",
      ),
    );
    await expect(store.forkBranch("leaf")).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(store.getState().sessions.map(({ id }) => id)).toContain(
        "fork-session",
      ),
    );
    expect(lookups.flat()).toEqual(
      expect.arrayContaining(["new-session", "fork-session"]),
    );
    expect(store.getState().sessionId).toBe("fork-session");
  });

  it("keeps base and curated rows through a failed supplemental read, then retries the union", async () => {
    const hiddenSessionIds = Array.from(
      { length: 500 },
      (_, index) => `hidden-${index}`,
    );
    const pinnedSessionIds = Array.from(
      { length: 100 },
      (_, index) => `pinned-${index}`,
    );
    const folder = sessionSummary({ id: "folder-row", cwd: "/work/pinned" });
    let phase: "initial" | "failing" | "retry" = "initial";
    let preserving = false;
    let baseCalls = 0;
    const preserveChunks: number[] = [];
    installCatalog(
      () => {
        baseCalls++;
        if (phase !== "initial" && baseCalls > 1) preserving = true;
        return {
          body: sessionPage([sessionSummary({ id: "confirmed-base" })], 1),
        };
      },
      {
        preferences: {
          pinnedSessionIds,
          hiddenSessionIds,
          pinnedProjectCwds: [folder.cwd],
        },
        routes: (url, init) => {
          if (url.startsWith("/api/sessions/by-id")) {
            const ids = (jsonBody(init).ids as string[]) ?? [];
            if (phase === "initial") {
              return {
                body: {
                  sessions:
                    ids.length > 0 ? [sessionSummary({ id: ids[0]! })] : [],
                },
              };
            }
            if (!preserving) return { body: { sessions: [] } };
            preserveChunks.push(ids.length);
            if (phase === "failing" && preserveChunks.length === 2) {
              return {
                status: 503,
                body: { error: "second id chunk unavailable" },
              };
            }
            return {
              body: { sessions: ids.map((id) => sessionSummary({ id })) },
            };
          }
          if (url.startsWith("/api/sessions/by-cwd")) {
            return {
              body: {
                sessions: [
                  phase === "retry"
                    ? { ...folder, title: "New folder title" }
                    : folder,
                ],
              },
            };
          }
        },
      },
    );
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "confirmed-base",
        "pinned-0",
        folder.id,
      ]),
    );

    vi.useFakeTimers();
    phase = "failing";
    socket.emit({
      type: "message_start",
      sessionId: "live-1",
      sessionStatus: { runState: "running" },
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit({
      type: "agent_settled",
      sessionId: "live-2",
      sessionStatus: { runState: "idle" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().sessionListError).toBeNull();

    expect(preserveChunks).toEqual([600, 1]);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "confirmed-base",
      "pinned-0",
      folder.id,
    ]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListOperation: null,
    });

    phase = "retry";
    preserveChunks.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preserveChunks).toEqual([600, 1]);
    expect(store.getState().sessions).toHaveLength(604);
    expect(
      store.getState().sessions.find(({ id }) => id === folder.id)?.title,
    ).toBe("New folder title");
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListError: null,
    });
  });

  it.each(["curated", "live"] as const)(
    "routes %s hydration 401 through transport auth without dropping the catalog",
    async (source) => {
      const ids = Array.from({ length: 80 }, (_, index) => `base-${index}`);
      installCatalog((page) => pageFromIds(ids, page), {
        preferences:
          source === "curated"
            ? { pinnedSessionIds: ["requires-auth"] }
            : undefined,
        routes: (url) =>
          url === "/api/sessions/by-id"
            ? { status: 401, body: { error: "token expired" } }
            : undefined,
      });
      const { store, socket } = await initStore();
      if (source === "live") {
        await vi.waitFor(() =>
          expect(store.getState().sessionListNextOffset).toBe(40),
        );
        socket.emit({
          type: "message_start",
          sessionId: "requires-auth",
          sessionStatus: { runState: "running" },
        });
      }
      await vi.waitFor(() =>
        expect(store.getState()).toMatchObject({
          needsToken: true,
          connection: "offline",
          sessionListNextOffset: 40,
          sessionListTotal: 80,
          sessionListLoading: false,
          sessionListLoadingOlder: false,
          sessionListHydrating: false,
          sessionListOperation: null,
          sessionListError: null,
        }),
      );
      expect(store.getState().sessions.map(({ id }) => id)).toEqual(
        ids.slice(0, 40),
      );
    },
  );

  it("retries a preserved multi-page extent atomically and abandons it when the query changes", async () => {
    const oldIds = Array.from({ length: 260 }, (_, index) => `old-${index}`);
    const refreshedIds = [
      "added",
      ...oldIds.map((id) => id.replace("old", "fresh")),
    ];
    const secondPage = deferred<void>();
    let phase: "initial" | "failed" | "retry" | "superseded" = "initial";
    const requests: Array<[number, number]> = [];
    installCatalog(
      async (page) => {
        if (page.query === "new-query")
          return pageFromIds(["new-result"], page);
        if (phase === "initial") return pageFromIds(oldIds, page);
        requests.push([page.offset, page.limit]);
        if (page.offset === 100) {
          if (phase === "failed")
            return { status: 503, body: { error: "middle page unavailable" } };
          if (phase === "superseded") await secondPage.promise;
        }
        return pageFromIds(refreshedIds, page);
      },
      {
        routes: (url) =>
          url === "/api/sessions/by-id"
            ? { body: { sessions: [] } }
            : undefined,
      },
    );
    const { store, socket } = await initStore();
    const ids = () => store.getState().sessions.map(({ id }) => id);
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    for (let page = 0; page < 5; page++) await store.loadOlderSessions();
    expect(ids()).toEqual(oldIds.slice(0, 240));

    const settle = (sessionId: string) =>
      socket.emit({
        type: "agent_settled",
        sessionId,
        sessionStatus: { runState: "idle" },
      });
    vi.useFakeTimers();
    phase = "failed";
    settle("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([
      [0, 100],
      [100, 100],
    ]);
    expect(ids()).toEqual(oldIds.slice(0, 240));
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListError: null,
    });

    phase = "retry";
    requests.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toEqual([
      [0, 100],
      [100, 100],
      [200, 41],
    ]);
    expect(ids()).toEqual(refreshedIds.slice(0, 241));

    phase = "superseded";
    requests.length = 0;
    settle("other-background");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([
      [0, 100],
      [100, 100],
    ]);
    expect(ids()).toEqual(refreshedIds.slice(0, 241));
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListOperation: null,
      sessionListNextOffset: 241,
    });
    await store.loadSessions("new-query");
    secondPage.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([
      [0, 100],
      [100, 100],
    ]);
    expect(ids()).toEqual(["new-result"]);
    expect(store.getState()).toMatchObject({
      sessionQuery: "new-query",
      sessionListNextOffset: 1,
      sessionListTotal: 1,
      sessionListError: null,
    });
  });

  it("recovers live rows in place and retires their retries when the query changes", async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `base-${index}`);
    const retired = deferred<void>();
    const replacement = deferred<void>();
    const hydrationAttempts = new Map<string, number>();
    let listRequests = 0;
    installCatalog(
      (page) => {
        if (page.query) return pageFromIds(["match"], page);
        listRequests++;
        return pageFromIds(ids, page);
      },
      {
        routes: async (url, init) => {
          if (url.startsWith("/api/sessions/by-id")) {
            const [id] = jsonBody(init).ids as [string];
            const attempt = (hydrationAttempts.get(id) ?? 0) + 1;
            hydrationAttempts.set(id, attempt);
            if (id === "absent" || (id === "materializing" && attempt === 1))
              return { body: { sessions: [] } };
            if (id === "race" && attempt > 1) {
              await (attempt === 2 ? retired.promise : replacement.promise);
              return {
                body: {
                  sessions: [
                    sessionSummary({
                      id,
                      title: attempt === 2 ? "Stale" : "Current",
                    }),
                  ],
                },
              };
            }
            if (["unavailable", "race"].includes(id) && attempt === 1)
              return {
                status: 503,
                body: { error: "live hydration unavailable" },
              };
            return { body: { sessions: [sessionSummary({ id })] } };
          }
        },
      },
    );
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    for (let index = 0; index < 5; index += 1) await store.loadOlderSessions();
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListTotal: 300,
    });
    expect(listRequests).toBe(6);

    vi.useFakeTimers();
    const live = (id: string) =>
      socket.emit({
        type: "message_start",
        sessionId: id,
        sessionStatus: { runState: "running" },
      });
    live("unavailable");
    live("materializing");
    live("absent");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListTotal: 300,
      sessionListOperation: null,
      sessionListHydrating: false,
      sessionListError: null,
    });
    expect(store.getState().sessions).toHaveLength(240);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      store
        .getState()
        .sessions.slice(240)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["materializing", "unavailable"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hydrationAttempts.get("absent")).toBe(4);
    expect(listRequests).toBe(6);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListTotal: 300,
      sessionListOperation: null,
      sessionListHydrating: false,
      sessionListError: null,
    });

    live("race");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hydrationAttempts.get("race")).toBe(2);
    await store.loadSessions("needle");
    expect(store.getState().sessions.map(({ id }) => id)).toEqual(["match"]);

    store.searchSessions("");
    live("race");
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrationAttempts.get("race")).toBe(3);
    retired.resolve();
    await vi.advanceTimersByTimeAsync(0);
    live("race");
    expect(hydrationAttempts.get("race")).toBe(3);
    expect(store.getState().sessions).not.toContainEqual(
      expect.objectContaining({ id: "race" }),
    );

    replacement.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 40,
      sessionListTotal: 300,
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListError: null,
    });
    expect(
      store
        .getState()
        .sessions.slice(0, 40)
        .map(({ id }) => id),
    ).toEqual(ids.slice(0, 40));
    expect(
      store.getState().sessions.find(({ id }) => id === "race")?.title,
    ).toBe("Current");
  });

  it("reissues the current query after reconnect without replaying its retired debounce or auth failure", async () => {
    vi.useFakeTimers();
    const stale = deferred<void>();
    const requests: string[] = [];
    let staleSignal: AbortSignal | null | undefined;
    installCatalog(async (page) => {
      requests.push(page.query);
      if (page.query === "stale") {
        staleSignal = page.signal;
        await stale.promise;
        return { status: 401, body: { error: "Old transport" } };
      }
      return pageFromIds([page.query || "base"], page);
    });
    const { store } = await initStore();
    await vi.advanceTimersByTimeAsync(0);
    const loading = store.loadSessions("stale");
    store.searchSessions("latest");
    await store.init();
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(staleSignal?.aborted).toBe(true);
    stale.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["", "stale", "latest"]);
    expect(store.getState()).toMatchObject({
      needsToken: false,
      sessionQuery: "latest",
      sessionListError: null,
      sessions: [{ id: "latest" }],
    });
  });
});
