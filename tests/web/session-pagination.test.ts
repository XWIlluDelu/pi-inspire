import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppStore } from "../../src/store";
import {
  catalogRows,
  installCatalog,
  type PageRequest,
  pageOf,
  pageResult,
} from "./fixtures/session-catalog";
import {
  activeSnapshot,
  deferred,
  type FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  sessionSummary,
} from "./helpers";

const ids = (store: AppStore) => store.getState().sessions.map(({ id }) => id);
const numbered = (prefix: string, size: number) =>
  Array.from({ length: size }, (_, index) => `${prefix}-${index}`);
const supplement = (names: readonly string[]) => ({
  body: { sessions: catalogRows(names) },
});
const live = (socket: FakeWebSocket, sessionId: string, settles = false) =>
  socket.emit({
    type: settles ? "agent_settled" : "message_start",
    sessionId,
    sessionStatus: { runState: settles ? "idle" : "running" },
  });
const clock = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const failed = { status: 503, body: { error: "Catalog source unavailable" } };
const unauthorized = { status: 401, body: { error: "Pairing expired" } };

beforeEach(() => installFakeWebSocket());
afterEach(() => vi.useRealTimers());

it.each(["curation", "older page"] as const)(
  "merges duplicate/curated rows using server offsets when %s finishes first",
  async (first) => {
    const append = deferred<void>();
    const curated = deferred<void>();
    const offsets: number[] = [];
    const pages = [
      ["s0", "s1"],
      ["s1", "s2"],
      ["s3", "s4"],
    ];
    const { store } = await installCatalog(
      async ({ offset }) => {
        offsets.push(offset);
        if (offset) await append.promise;
        return pageResult(pages[offset / 2]!, 6, offset);
      },
      {
        routes: async (url) => {
          if (url === "/api/sessions/by-id") {
            await curated.promise;
            return supplement(["pinned"]);
          }
        },
      },
    );
    await vi.waitFor(() => expect(ids(store)).toEqual(["s0", "s1"]));
    const older = store.catalog.loadOlder();
    const duplicate = store.catalog.loadOlder();
    store.preferences.toggleSessionPin("pinned");
    await vi.waitFor(() =>
      expect(store.getState().sessionListHydrating).toBe(true),
    );
    if (first === "curation") {
      curated.resolve();
      await vi.waitFor(() =>
        expect(ids(store)).toEqual(["s0", "s1", "pinned"]),
      );
      expect(store.getState().sessionListNextOffset).toBe(2);
    }
    append.resolve();
    await Promise.all([older, duplicate]);
    if (first === "older page") {
      expect(ids(store)).toEqual(["s0", "s1", "s2"]);
      curated.resolve();
    }
    await store.catalog.loadOlder();
    await vi.waitFor(() =>
      expect(ids(store)).toEqual(["s0", "s1", "s2", "s3", "s4", "pinned"]),
    );
    expect(offsets).toEqual([0, 2, 4]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 6,
      sessionListTotal: 6,
    });
  },
);

it.each(["replacement query", "transport"] as const)(
  "retires an old append when a %s takes ownership",
  async (change) => {
    const stale = deferred<void>();
    const list = vi.fn(async (page: PageRequest) => {
      if (page.query)
        return pageOf(["match", "current-older"], { ...page, limit: 1 });
      if (!page.offset) return pageResult(["recent"], 2);
      await stale.promise;
      return change === "transport"
        ? unauthorized
        : pageResult(["stale-older"], 2, 1);
    });
    const { store } = await installCatalog(list);
    await vi.waitFor(() => expect(ids(store)).toEqual(["recent"]));
    vi.useFakeTimers();
    const pending = store.catalog.loadOlder();
    if (change === "transport") {
      store.catalog.search("latest");
      await store.init();
      await clock(500);
    } else await store.catalog.load("latest");
    await store.catalog.loadOlder();
    stale.resolve();
    await pending;
    await clock();
    expect(list.mock.calls[1]![0].signal?.aborted).toBe(true);
    expect(
      list.mock.calls.map(([{ query, offset }]) => [query, offset]),
    ).toEqual([
      ["", 0],
      ["", 1],
      ["latest", 0],
      ["latest", 1],
    ]);
    expect(store.getState()).toMatchObject({
      needsToken: false,
      sessionQuery: "latest",
      sessionListError: null,
      sessionListNextOffset: 2,
      sessionListTotal: 2,
    });
    expect(ids(store)).toEqual(["match", "current-older"]);
  },
);

it("hydrates newly created and forked selections missing from the chronological page", async () => {
  const lookup = vi.fn(supplement);
  const { store } = await installCatalog(() => pageResult(["recent"]), {
    routes: (url, init) => {
      if (url === "/api/sessions/new")
        return {
          body: activeSnapshot({
            sessionId: "created",
            cwd: "/new",
            effectiveLeafId: "leaf",
          }),
        };
      if (url === "/api/branches/fork")
        return {
          body: {
            sessionId: "forked",
            snapshot: activeSnapshot({ sessionId: "forked" }),
            editorText: "prompt",
          },
        };
      if (url === "/api/sessions/by-id")
        return lookup(jsonBody(init).ids as string[]);
    },
  });
  await expect(store.selection.create("/new")).resolves.toBe("created");
  await vi.waitFor(() => expect(ids(store)).toContain("created"));
  await expect(store.branches.fork("leaf")).resolves.toBe(true);
  await vi.waitFor(() => expect(ids(store)).toContain("forked"));
  expect(lookup.mock.calls.flat(2)).toEqual(
    expect.arrayContaining(["created", "forked"]),
  );
  expect(store.getState().sessionId).toBe("forked");
});

it("keeps base and curated rows when a later supplemental chunk fails, then retries the whole union", async () => {
  const folder = sessionSummary({ id: "folder-row", cwd: "/work/pinned" });
  const removed = { ...folder, id: "removed" };
  const chunks: number[] = [];
  let phase = "initial";
  let rebuilt = false;
  const { store, socket } = await installCatalog(
    () => {
      if (phase !== "initial") rebuilt = true;
      return pageResult(["base"]);
    },
    {
      preferences: {
        pinnedSessionIds: numbered("pinned", 100),
        hiddenSessionIds: numbered("hidden", 500),
        pinnedProjectCwds: [folder.cwd],
      },
      routes: (url, init) => {
        if (url === "/api/sessions/by-cwd")
          return {
            body: {
              sessions: phase === "initial" ? [folder, removed] : [folder],
            },
          };
        if (url !== "/api/sessions/by-id") return;
        const names = jsonBody(init).ids as string[];
        if (phase === "initial") return supplement(names.slice(0, 1));
        if (!rebuilt) return supplement([]);
        chunks.push(names.length);
        return phase === "failure" && chunks.length === 2
          ? failed
          : {
              body: {
                sessions: catalogRows(names).map((row) => ({
                  ...row,
                  title: phase,
                })),
              },
            };
      },
    },
  );
  const confirmed = ["base", "pinned-0", folder.id, removed.id];
  await vi.waitFor(() => expect(ids(store)).toEqual(confirmed));
  vi.useFakeTimers();
  phase = "failure";
  live(socket, "live-1");
  await clock();
  live(socket, "live-2", true);
  await clock();
  expect(chunks.splice(0)).toHaveLength(2);
  expect(ids(store)).toEqual(confirmed);
  expect(store.getState()).toMatchObject({
    sessionListNextOffset: 1,
    sessionListOperation: null,
    sessionListError: null,
  });
  phase = "recovered";
  await clock(1_000);
  expect(chunks).toHaveLength(2);
  expect(ids(store)).not.toContain(removed.id);
  expect(ids(store)).toHaveLength(604);
  expect(
    store.getState().sessions.find(({ id }) => id === "pinned-0")?.title,
  ).toBe("recovered");
  expect(store.getState().sessionListNextOffset).toBe(1);
});

it.each(["curated", "live"] as const)(
  "retains the base page while a current %s lookup expires pairing",
  async (source) => {
    const base = numbered("base", 80);
    const { store, socket } = await installCatalog(
      (page) => pageOf(base, page),
      {
        preferences:
          source === "curated"
            ? { pinnedSessionIds: ["requires-auth"] }
            : undefined,
        routes: (url) =>
          url === "/api/sessions/by-id" ? unauthorized : undefined,
      },
    );
    if (source === "live") {
      await vi.waitFor(() =>
        expect(store.getState().sessionListNextOffset).toBe(40),
      );
      live(socket, "requires-auth");
    }
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({
        needsToken: true,
        connection: "offline",
        sessionListTotal: 80,
        sessionListNextOffset: 40,
        sessionListLoading: false,
        sessionListLoadingOlder: false,
        sessionListHydrating: false,
        sessionListOperation: null,
        sessionListError: null,
      }),
    );
    expect(ids(store)).toEqual(base.slice(0, 40));
  },
);

it("publishes a preserved multi-page extent atomically after retry", async () => {
  const initial = numbered("old", 260);
  const fresh = ["added", ...numbered("fresh", 260)];
  const release = deferred<void>();
  const requests: Array<[number, number]> = [];
  let phase = "initial";
  const { store, socket } = await installCatalog(
    async (page) => {
      if (page.query) return pageResult(["new-result"]);
      if (phase === "initial") return pageOf(initial, page);
      requests.push([page.offset, page.limit]);
      if (page.offset === 100) {
        if (phase === "failed") return failed;
        if (phase === "superseded") await release.promise;
      }
      return pageOf(fresh, page);
    },
    {
      routes: (url) =>
        url === "/api/sessions/by-id" ? supplement([]) : undefined,
    },
  );
  await vi.waitFor(() =>
    expect(store.getState().sessionListNextOffset).toBe(40),
  );
  for (let page = 0; page < 5; page++) await store.catalog.loadOlder();
  const middle = [
    [0, 100],
    [100, 100],
  ];
  vi.useFakeTimers();
  phase = "failed";
  live(socket, "background", true);
  await clock();
  expect(requests.splice(0)).toEqual(middle);
  expect(ids(store)).toEqual(initial.slice(0, 240));
  expect(store.getState().sessionListError).toBeNull();
  phase = "retry";
  await clock(1_000);
  expect(requests.splice(0)).toEqual([...middle, [200, 41]]);
  expect(ids(store)).toEqual(fresh.slice(0, 241));
  phase = "superseded";
  live(socket, "other-background", true);
  await clock();
  expect(ids(store)).toEqual(fresh.slice(0, 241));
  await store.catalog.load("new-query");
  release.resolve();
  await clock();
  expect(requests).toEqual(middle);
  expect(ids(store)).toEqual(["new-result"]);
  expect(store.getState()).toMatchObject({
    sessionQuery: "new-query",
    sessionListNextOffset: 1,
    sessionListError: null,
  });
});

it("recovers live rows without rereading a page or publishing a retired query's lookup", async () => {
  const base = numbered("base", 100);
  const retired = deferred<void>();
  const replacement = deferred<void>();
  const attempts = new Map<string, number>();
  const list = vi.fn((page: PageRequest) =>
    pageOf(page.query ? ["match"] : base, page),
  );
  const { store, socket } = await installCatalog(list, {
    routes: async (url, init) => {
      if (url !== "/api/sessions/by-id") return;
      const requested = jsonBody(init).ids as string[];
      if (requested.length > 1)
        return supplement(requested.filter((id) => id !== "absent"));
      const id = requested[0]!;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === "absent" || (id === "materializing" && attempt === 1))
        return supplement([]);
      if (attempt === 1) return failed;
      if (id !== "race") return supplement([id]);
      await (attempt === 2 ? retired.promise : replacement.promise);
      return {
        body: {
          sessions: [
            sessionSummary({ id, title: attempt === 2 ? "Stale" : "Current" }),
          ],
        },
      };
    },
  });
  await vi.waitFor(() =>
    expect(store.getState().sessionListNextOffset).toBe(40),
  );
  await store.catalog.loadOlder();
  vi.useFakeTimers();
  for (const id of ["unavailable", "materializing", "absent"]) live(socket, id);
  await clock();
  expect(ids(store)).toEqual(base.slice(0, 80));
  await clock(1_000);
  expect(ids(store).slice(80).sort()).toEqual(["materializing", "unavailable"]);
  await clock(30_000);
  for (let i = 0; i < 12; i++) {
    live(socket, "absent");
    await clock();
  }
  expect(attempts.get("absent")).toBe(4);
  expect(list).toHaveBeenCalledTimes(2);
  expect(store.getState().sessionListNextOffset).toBe(80);
  live(socket, "race");
  await clock(1_000);
  expect(attempts.get("race")).toBe(2);
  await store.catalog.load("needle");
  expect(ids(store)).toEqual(["match"]);
  store.catalog.search("");
  live(socket, "race");
  await clock();
  retired.resolve();
  await clock();
  live(socket, "race");
  expect(attempts.get("race")).toBe(3);
  expect(ids(store)).not.toContain("race");
  replacement.resolve();
  await clock();
  expect(store.getState().sessions.find(({ id }) => id === "race")?.title).toBe(
    "Current",
  );
  await clock(200);
  expect(store.getState()).toMatchObject({
    sessionListNextOffset: 40,
    sessionListHydrating: false,
    sessionListError: null,
  });
});
