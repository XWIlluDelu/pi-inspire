// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "../../src/store";
import {
  installCatalog,
  type PageRequest,
  sessionPage,
} from "./fixtures/session-catalog";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  jsonBody,
  sessionSummary,
} from "./helpers";

const rows = (ids: string[]) => ids.map((id) => sessionSummary({ id }));
const catalogIds = (store: AppStore) =>
  store.getState().sessions.map(({ id }) => id);
const pageResult = (
  ids: string[],
  total = ids.length,
  offset = 0,
  limit = 40,
) => ({ body: sessionPage(rows(ids), total, offset, limit) });
const pageOf = (
  ids: string[],
  { offset, limit }: Pick<PageRequest, "offset" | "limit">,
) => pageResult(ids.slice(offset, offset + limit), ids.length, offset, limit);
const numberedIds = (prefix: string, length: number) =>
  Array.from({ length }, (_, index) => `${prefix}-${index}`);

beforeEach(() => installFakeWebSocket());
afterEach(() => vi.useRealTimers());

describe("catalog reads", () => {
  it("paginates by the server offset even with duplicate and curated rows", async () => {
    const offsets: number[] = [];
    const pages = [
      ["s0", "s1"],
      ["s1", "s2"],
      ["s3", "s4"],
    ];
    const pinned = sessionSummary({ id: "pinned" });
    const hidden = sessionSummary({ id: "hidden", cwd: "/work/hidden" });
    const { store } = await installCatalog(
      ({ offset }) => {
        offsets.push(offset);
        return pageResult(pages[offset / 2]!, 6, offset);
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
    await vi.waitFor(() =>
      expect(catalogIds(store)).toEqual(["s0", "s1", pinned.id, hidden.id]),
    );
    await store.loadOlderSessions();
    await store.loadOlderSessions();
    expect(offsets).toEqual([0, 2, 4]);
    expect(catalogIds(store)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      pinned.id,
      hidden.id,
    ]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 6,
      sessionListTotal: 6,
    });
  });

  it("coalesces duplicate appends without blocking a replacement query", async () => {
    const retired = deferred<void>();
    const older = vi.fn(async () => {
      await retired.promise;
      return pageResult(["stale-older"], 2, 1);
    });
    const { store } = await installCatalog(({ query, offset }) => {
      if (query)
        return pageOf(["match", "current-older"], { offset, limit: 1 });
      return offset ? older() : pageResult(["recent"], 2);
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(1),
    );
    const first = store.loadOlderSessions();
    const duplicate = store.loadOlderSessions();
    await vi.waitFor(() => expect(older).toHaveBeenCalledOnce());

    await store.loadSessions("needle");
    await store.loadOlderSessions();
    retired.resolve();
    await Promise.all([first, duplicate]);
    expect(older).toHaveBeenCalledOnce();
    expect(catalogIds(store)).toEqual(["match", "current-older"]);
    expect(store.getState()).toMatchObject({
      sessionQuery: "needle",
      sessionListNextOffset: 2,
      sessionListTotal: 2,
    });
  });

  it.each(["older", "curation"] as const)(
    "keeps both catalog contributions when %s finishes first",
    async (first) => {
      const older = deferred<void>();
      const curated = deferred<void>();
      const { store } = await installCatalog(
        async (page) => {
          if (page.offset) await older.promise;
          return pageOf(["recent", "older"], { ...page, limit: 1 });
        },
        {
          routes: async (url, init) => {
            if (url === "/api/preferences") return { body: jsonBody(init) };
            if (url === "/api/sessions/by-id") {
              await curated.promise;
              return { body: { sessions: rows(["pinned"]) } };
            }
          },
        },
      );
      await vi.waitFor(() => expect(catalogIds(store)).toEqual(["recent"]));
      const loading = store.loadOlderSessions();
      store.toggleSessionPin("pinned");
      await vi.waitFor(() =>
        expect(store.getState().sessionListHydrating).toBe(true),
      );

      if (first === "curation") {
        curated.resolve();
        await vi.waitFor(() =>
          expect(catalogIds(store)).toEqual(["recent", "pinned"]),
        );
        expect(store.getState().sessionListNextOffset).toBe(1);
      }
      older.resolve();
      await loading;
      if (first === "older") {
        expect(store.getState().sessionListHydrating).toBe(true);
        curated.resolve();
      }
      await vi.waitFor(() =>
        expect(catalogIds(store)).toEqual(["recent", "older", "pinned"]),
      );
      expect(store.getState().sessionListNextOffset).toBe(2);
    },
  );

  it("replaces prior pages only after an explicit refresh completes", async () => {
    const refresh = deferred<void>();
    let refreshing = false;
    const list = vi.fn(({ offset }: PageRequest) =>
      refreshing
        ? pageResult(["refreshed"])
        : pageResult([offset ? "older" : "recent"], 2, offset),
    );
    const { store } = await installCatalog(list, {
      routes: async (url) => {
        if (url !== "/api/sessions/refresh") return;
        refreshing = true;
        await refresh.promise;
        return { body: { ok: true } };
      },
    });
    await vi.waitFor(() => expect(catalogIds(store)).toEqual(["recent"]));
    await store.loadOlderSessions();
    const refreshingPromise = store.refreshSessions();
    await vi.waitFor(() => expect(refreshing).toBe(true));
    expect(catalogIds(store)).toEqual(["recent", "older"]);
    refresh.resolve();
    await refreshingPromise;

    expect(list.mock.calls.map(([{ offset }]) => offset)).toEqual([0, 1, 0]);
    expect(catalogIds(store)).toEqual(["refreshed"]);
    expect(store.getState().sessionListNextOffset).toBe(1);
  });

  it("hydrates new and forked selections missing from the current page", async () => {
    const created = activeSnapshot({
      sessionId: "created",
      cwd: "/work/new",
      effectiveLeafId: "leaf",
    });
    const forked = activeSnapshot({ sessionId: "forked", cwd: "/work/fork" });
    const lookup = vi.fn((ids: string[]) => ({
      body: { sessions: rows(ids) },
    }));
    const { store } = await installCatalog(() => pageResult(["recent"]), {
      routes: (url, init) => {
        if (url === "/api/sessions/new") return { body: created };
        if (url === "/api/branches/fork")
          return {
            body: {
              sessionId: "forked",
              snapshot: forked,
              editorText: "prompt",
            },
          };
        if (url === "/api/sessions/by-id")
          return lookup(jsonBody(init).ids as string[]);
      },
    });

    await store.newSession("/work/new");
    await vi.waitFor(() => expect(catalogIds(store)).toContain("created"));
    await expect(store.forkBranch("leaf")).resolves.toBe(true);
    await vi.waitFor(() => expect(catalogIds(store)).toContain("forked"));
    expect(lookup.mock.calls.flat(2)).toEqual(
      expect.arrayContaining(["created", "forked"]),
    );
    expect(store.getState().sessionId).toBe("forked");
  });

  it("keeps base and curated rows through a failed supplemental read, then retries the union", async () => {
    const folder = sessionSummary({ id: "folder-row", cwd: "/work/pinned" });
    let phase: "initial" | "failing" | "retry" = "initial";
    let preserving = false;
    const chunks: number[] = [];
    const { store, socket } = await installCatalog(
      () => {
        if (phase !== "initial") preserving = true;
        return pageResult(["base"]);
      },
      {
        preferences: {
          pinnedSessionIds: numberedIds("pinned", 100),
          hiddenSessionIds: numberedIds("hidden", 500),
          pinnedProjectCwds: [folder.cwd],
        },
        routes: (url, init) => {
          if (url === "/api/sessions/by-cwd")
            return { body: { sessions: [{ ...folder, title: phase }] } };
          if (url !== "/api/sessions/by-id") return;
          const ids = jsonBody(init).ids as string[];
          if (phase === "initial")
            return { body: { sessions: rows(ids.slice(0, 1)) } };
          if (!preserving) return { body: { sessions: [] } };
          chunks.push(ids.length);
          return phase === "failing" && chunks.length === 2
            ? { status: 503, body: { error: "second id chunk unavailable" } }
            : { body: { sessions: rows(ids) } };
        },
      },
    );
    const confirmed = ["base", "pinned-0", folder.id];
    await vi.waitFor(() => expect(catalogIds(store)).toEqual(confirmed));
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
    expect(chunks.splice(0)).toEqual([600, 1]);
    expect(catalogIds(store)).toEqual(confirmed);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListOperation: null,
      sessionListError: null,
    });

    phase = "retry";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chunks).toEqual([600, 1]);
    expect(store.getState().sessions).toHaveLength(604);
    expect(
      store.getState().sessions.find(({ id }) => id === folder.id)?.title,
    ).toBe("retry");
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListError: null,
    });
  });

  it.each(["curated", "live"] as const)(
    "routes %s hydration 401 through transport auth without dropping the catalog",
    async (source) => {
      const ids = numberedIds("base", 80);
      const { store, socket } = await installCatalog(
        (page) => pageOf(ids, page),
        {
          preferences:
            source === "curated"
              ? { pinnedSessionIds: ["requires-auth"] }
              : undefined,
          routes: (url) =>
            url === "/api/sessions/by-id"
              ? { status: 401, body: { error: "token expired" } }
              : undefined,
        },
      );
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
      expect(catalogIds(store)).toEqual(ids.slice(0, 40));
    },
  );

  it("retries a preserved multi-page extent atomically and abandons it when the query changes", async () => {
    const initial = numberedIds("old", 260);
    const refreshed = ["added", ...numberedIds("fresh", 260)];
    const release = deferred<void>();
    let phase: "initial" | "failed" | "retry" | "superseded" = "initial";
    const requests: Array<[number, number]> = [];
    const { store, socket } = await installCatalog(
      async (page) => {
        if (page.query) return pageResult(["new-result"]);
        if (phase === "initial") return pageOf(initial, page);
        requests.push([page.offset, page.limit]);
        if (page.offset === 100) {
          if (phase === "failed")
            return { status: 503, body: { error: "middle page unavailable" } };
          if (phase === "superseded") await release.promise;
        }
        return pageOf(refreshed, page);
      },
      {
        routes: (url) =>
          url === "/api/sessions/by-id"
            ? { body: { sessions: [] } }
            : undefined,
      },
    );
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    for (let page = 0; page < 5; page++) await store.loadOlderSessions();
    const middle: Array<[number, number]> = [
      [0, 100],
      [100, 100],
    ];
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
    expect(requests.splice(0)).toEqual(middle);
    expect(catalogIds(store)).toEqual(initial.slice(0, 240));
    expect(store.getState().sessionListError).toBeNull();

    phase = "retry";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.splice(0)).toEqual([...middle, [200, 41]]);
    expect(catalogIds(store)).toEqual(refreshed.slice(0, 241));

    phase = "superseded";
    settle("other-background");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(middle);
    expect(catalogIds(store)).toEqual(refreshed.slice(0, 241));
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListNextOffset: 241,
    });
    await store.loadSessions("new-query");
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(middle);
    expect(catalogIds(store)).toEqual(["new-result"]);
    expect(store.getState()).toMatchObject({
      sessionQuery: "new-query",
      sessionListNextOffset: 1,
      sessionListError: null,
    });
  });

  it("recovers live rows without refetching the page and retires their retries on query change", async () => {
    const ids = numberedIds("base", 100);
    const retired = deferred<void>();
    const replacement = deferred<void>();
    const attempts = new Map<string, number>();
    const list = vi.fn((page: PageRequest) =>
      pageOf(page.query ? ["match"] : ids, page),
    );
    const { store, socket } = await installCatalog(list, {
      routes: async (url, init) => {
        if (url !== "/api/sessions/by-id") return;
        const [id] = jsonBody(init).ids as [string];
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === "absent" || (id === "materializing" && attempt === 1))
          return { body: { sessions: [] } };
        if (attempt === 1 && ["unavailable", "race"].includes(id))
          return { status: 503, body: { error: "live hydration unavailable" } };
        if (id === "race") {
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
        return { body: { sessions: rows([id]) } };
      },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    await store.loadOlderSessions();

    vi.useFakeTimers();
    const live = (id: string) =>
      socket.emit({
        type: "message_start",
        sessionId: id,
        sessionStatus: { runState: "running" },
      });
    for (const id of ["unavailable", "materializing", "absent"]) live(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogIds(store)).toEqual(ids.slice(0, 80));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(catalogIds(store).slice(80).sort()).toEqual([
      "materializing",
      "unavailable",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts.get("absent")).toBe(4);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 80,
      sessionListTotal: 100,
      sessionListError: null,
    });

    live("race");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.get("race")).toBe(2);
    await store.loadSessions("needle");
    expect(catalogIds(store)).toEqual(["match"]);

    store.searchSessions("");
    live("race");
    await vi.advanceTimersByTimeAsync(0);
    retired.resolve();
    await vi.advanceTimersByTimeAsync(0);
    live("race");
    expect(attempts.get("race")).toBe(3);
    expect(catalogIds(store)).not.toContain("race");

    replacement.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(catalogIds(store).slice(0, 40)).toEqual(ids.slice(0, 40));
    expect(
      store.getState().sessions.find(({ id }) => id === "race")?.title,
    ).toBe("Current");
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 40,
      sessionListHydrating: false,
      sessionListError: null,
    });
  });

  it("reissues the current query after reconnect without replaying its retired debounce or auth failure", async () => {
    vi.useFakeTimers();
    const stale = deferred<void>();
    let staleSignal: AbortSignal | null | undefined;
    const list = vi.fn(async (page: PageRequest) => {
      if (page.query !== "stale") return pageResult([page.query || "base"]);
      staleSignal = page.signal;
      await stale.promise;
      return { status: 401, body: { error: "Old transport" } };
    });
    const { store } = await installCatalog(list);
    await vi.advanceTimersByTimeAsync(0);
    const loading = store.loadSessions("stale");
    store.searchSessions("latest");
    await store.init();
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(staleSignal?.aborted).toBe(true);
    stale.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(list.mock.calls.map(([{ query }]) => query)).toEqual([
      "",
      "stale",
      "latest",
    ]);
    expect(store.getState()).toMatchObject({
      needsToken: false,
      sessionQuery: "latest",
      sessionListError: null,
      sessions: [{ id: "latest" }],
    });
  });
});
