// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

function emptyBootstrap(preferences = bootstrapPayload().preferences) {
  return bootstrapPayload({
    preferences,
    snapshot: { active: null, runState: "idle", sessionStatuses: {} },
  });
}

async function initStore(): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}

function offsetOf(url: string): number {
  return Number(new URL(url, "http://local").searchParams.get("offset") ?? 0);
}

describe("session list pagination", () => {
  beforeEach(() => installFakeWebSocket());

  it("loads more than three pages while curated identities and duplicate rows never advance the display cursor", async () => {
    const requests: number[] = [];
    const basePages = new Map<number, string[]>([
      [0, ["s0", "s1"]],
      [2, ["s1", "s2"]],
      [4, ["s3", "s4"]],
      [6, ["s5", "s6"]],
    ]);
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: emptyBootstrap({
            ...bootstrapPayload().preferences,
            pinnedSessionIds: ["pinned-off-page"],
            hiddenSessionIds: ["hidden-off-page"],
            pinnedProjectCwds: ["/work/pinned-folder"],
          }),
        };
      if (url.startsWith("/api/sessions/by-id")) {
        const ids = (jsonBody(init).ids as string[]) ?? [];
        return {
          body: {
            sessions: ids.map((id) =>
              sessionSummary({ id, cwd: "/work/curated" }),
            ),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        return {
          body: {
            sessions: [
              sessionSummary({
                id: "folder-off-page",
                cwd: "/work/pinned-folder",
              }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        const offset = offsetOf(url);
        requests.push(offset);
        return {
          body: {
            sessions: (basePages.get(offset) ?? []).map((id) =>
              sessionSummary({ id, cwd: `/work/${id}` }),
            ),
            total: 8,
            offset,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(2),
    );

    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "s0",
      "s1",
      "pinned-off-page",
      "hidden-off-page",
      "folder-off-page",
    ]);
    // Five rendered identities consumed only two chronological server rows.
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 2,
      sessionListTotal: 8,
    });

    await store.loadOlderSessions();
    expect(store.getState().sessionListNextOffset).toBe(4);
    expect(
      store.getState().sessions.filter((session) => session.id === "s1"),
    ).toHaveLength(1);
    await store.loadOlderSessions();
    await store.loadOlderSessions();

    expect(requests).toEqual([0, 2, 4, 6]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 8,
      sessionListTotal: 8,
    });
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "pinned-off-page",
      "hidden-off-page",
      "folder-off-page",
    ]);
  });

  it("coalesces duplicate load-more requests and discards an old page after a query reset", async () => {
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let olderCalls = 0;
    installFetch(async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const query = parsed.searchParams.get("q") ?? "";
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        if (query === "needle") {
          return {
            body: {
              sessions: [
                sessionSummary({
                  id: offset === 0 ? "match" : "current-older",
                }),
              ],
              total: 2,
              offset,
              limit: 40,
            },
          };
        }
        if (offset === 0) {
          return {
            body: {
              sessions: [sessionSummary({ id: "recent" })],
              total: 2,
              offset: 0,
              limit: 40,
            },
          };
        }
        olderCalls += 1;
        await olderGate;
        return {
          body: {
            sessions: [sessionSummary({ id: "stale-older" })],
            total: 2,
            offset: 1,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(1),
    );

    const first = store.loadOlderSessions();
    const duplicate = store.loadOlderSessions();
    expect(duplicate).toBe(first);
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
    releaseOlder();
    await first;
    expect(olderCalls).toBe(1);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "match",
      "current-older",
    ]);
  });

  it("invalidates an in-flight older page when curation changes without dropping the newly hydrated row", async () => {
    let releaseOlder!: () => void;
    let olderStarted!: () => void;
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const started = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/preferences"))
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      if (url.startsWith("/api/sessions/by-id")) {
        const ids = (jsonBody(init).ids as string[]) ?? [];
        return {
          body: {
            sessions: ids.map((id) =>
              sessionSummary({ id, cwd: "/work/curated" }),
            ),
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        const offset = offsetOf(url);
        if (offset === 0)
          return {
            body: {
              sessions: [sessionSummary({ id: "recent" })],
              total: 2,
              offset,
              limit: 40,
            },
          };
        olderStarted();
        await olderGate;
        return {
          body: {
            sessions: [sessionSummary({ id: "obsolete-page" })],
            total: 2,
            offset,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(1),
    );

    const older = store.loadOlderSessions();
    await started;
    store.toggleSessionPin("curated-outside-page");
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .sessions.some((session) => session.id === "curated-outside-page"),
      ).toBe(true),
    );
    releaseOlder();
    await older;

    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "recent",
      "curated-outside-page",
    ]);
    expect(store.getState().sessionListNextOffset).toBe(1);
  });

  it("retains confirmed pages after an error and retries the same authoritative offset", async () => {
    let attempts = 0;
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions?")) {
        const offset = offsetOf(url);
        if (offset === 0)
          return {
            body: {
              sessions: [sessionSummary({ id: "kept" })],
              total: 2,
              offset,
              limit: 40,
            },
          };
        attempts += 1;
        if (attempts === 1)
          return {
            status: 503,
            body: { error: "catalog temporarily unavailable" },
          };
        return {
          body: {
            sessions: [sessionSummary({ id: "retried" })],
            total: 2,
            offset,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "kept",
      ]),
    );

    await store.loadOlderSessions();
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "kept",
    ]);
    expect(store.getState().sessionListError).toBe(
      "catalog temporarily unavailable",
    );
    expect(store.getState().sessionListNextOffset).toBe(1);

    await store.retrySessionList();
    expect(attempts).toBe(2);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "kept",
      "retried",
    ]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 2,
      sessionListError: null,
    });
  });

  it("explicit refresh starts at offset zero, is latest-wins, and retains prior pages until replacement", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshing = false;
    const offsets: number[] = [];
    installFetch(async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/refresh")) {
        refreshing = true;
        await refreshGate;
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/sessions?")) {
        const offset = offsetOf(url);
        offsets.push(offset);
        return {
          body: {
            sessions: [
              sessionSummary({
                id: refreshing
                  ? "refreshed"
                  : offset === 0
                    ? "recent"
                    : "older",
              }),
            ],
            total: refreshing ? 1 : 2,
            offset,
            limit: 40,
          },
        };
      }
      return undefined;
    });
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
    releaseRefresh();
    await refreshingPromise;

    expect(offsets).toEqual([0, 1, 0]);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "refreshed",
    ]);
    expect(store.getState().sessionListNextOffset).toBe(1);
  });

  it("preserves the loaded extent on background settlement and hydrates new and forked selections", async () => {
    let currentIds = ["recent", "older"];
    const byId = new Map<string, ReturnType<typeof sessionSummary>>();
    byId.set(
      "new-session",
      sessionSummary({ id: "new-session", cwd: "/work/new" }),
    );
    byId.set(
      "fork-session",
      sessionSummary({ id: "fork-session", cwd: "/work/fork" }),
    );
    const offsets: Array<[number, number]> = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id")) {
        const ids = (jsonBody(init).ids as string[]) ?? [];
        return {
          body: {
            sessions: ids.flatMap((id) =>
              byId.has(id) ? [byId.get(id)!] : [],
            ),
          },
        };
      }
      if (url.startsWith("/api/sessions/new")) {
        return {
          body: activeSnapshot({
            sessionId: "new-session",
            cwd: "/work/new",
            effectiveLeafId: "leaf",
          }),
        };
      }
      if (url.startsWith("/api/branches/tree"))
        return {
          body: {
            sessionId: "new-session",
            revision: 1,
            incarnation: "inc",
            durableLeafId: "leaf",
            effectiveLeafId: "leaf",
            activePath: ["leaf"],
            nodes: [
              {
                id: "leaf",
                parentId: null,
                depth: 0,
                type: "message",
                role: "user",
                label: "User",
                snippet: "prompt",
                timestamp: "2026-01-01T00:00:00Z",
                active: true,
                leaf: true,
                canSwitch: false,
                canEdit: false,
                canFork: true,
              },
            ],
            truncated: false,
            health: { status: "ok" },
          },
        };
      if (url.startsWith("/api/branches/fork"))
        return {
          body: {
            sessionId: "fork-session",
            snapshot: activeSnapshot({
              sessionId: "fork-session",
              cwd: "/work/fork",
            }),
            editorText: "prompt",
          },
        };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        offsets.push([offset, limit]);
        const ids = currentIds.slice(offset, offset + limit);
        return {
          body: {
            sessions: ids.map((id) => sessionSummary({ id })),
            total: currentIds.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(2),
    );

    currentIds = ["updated-recent", "recent", "older"];
    socket.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessions[0]?.id).toBe("updated-recent"),
    );
    expect(
      store
        .getState()
        .sessions.slice(0, 3)
        .map((session) => session.id),
    ).toEqual(["updated-recent", "recent", "older"]);
    expect(store.getState().sessionListNextOffset).toBe(3);
    expect(offsets.slice(-2)).toEqual([
      [0, 2],
      [2, 1],
    ]);

    await store.newSession("/work/new");
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .sessions.some((session) => session.id === "new-session"),
      ).toBe(true),
    );
    await store.loadBranchTree();
    await expect(store.forkBranch("leaf")).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .sessions.some((session) => session.id === "fork-session"),
      ).toBe(true),
    );
    expect(store.getState().sessionId).toBe("fork-session");
  });

  it("chunks 600 curated ids plus the active identity within the by-id route bound", async () => {
    const pinnedSessionIds = Array.from(
      { length: 100 },
      (_, index) => `pinned-${index}`,
    );
    const hiddenSessionIds = Array.from(
      { length: 500 },
      (_, index) => `hidden-${index}`,
    );
    const chunkSizes: number[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              pinnedSessionIds,
              hiddenSessionIds,
            },
            snapshot: activeSnapshot({ sessionId: "active-outside-curation" }),
          }),
        };
      if (url.startsWith("/api/sessions/by-id")) {
        const ids = (jsonBody(init).ids as string[]) ?? [];
        chunkSizes.push(ids.length);
        return { body: { sessions: ids.map((id) => sessionSummary({ id })) } };
      }
      if (url.startsWith("/api/sessions?")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return undefined;
    });
    const { store } = await initStore();

    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(601));
    // The stream snapshot can concurrently request its active row while the
    // catalog hydrates the full curated union; every request remains bounded.
    expect(chunkSizes).toContain(600);
    expect(chunkSizes).toContain(1);
    expect(chunkSizes.every((size) => size <= 600)).toBe(true);
    expect(store.getState().sessionListError).toBeNull();
  });

  it("retains confirmed base and curated rows when a later id chunk fails, then retries hydration", async () => {
    const hiddenSessionIds = Array.from(
      { length: 500 },
      (_, index) => `hidden-${index}`,
    );
    const pinnedSessionIds = Array.from(
      { length: 100 },
      (_, index) => `pinned-${index}`,
    );
    let phase: "initial" | "failing" | "retry" = "initial";
    let preserving = false;
    let baseCalls = 0;
    const preserveChunks: number[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: emptyBootstrap({
            ...bootstrapPayload().preferences,
            pinnedSessionIds,
            hiddenSessionIds,
          }),
        };
      if (url.startsWith("/api/sessions/by-id")) {
        const ids = (jsonBody(init).ids as string[]) ?? [];
        if (phase === "initial") {
          return {
            body: {
              sessions: ids.length > 0 ? [sessionSummary({ id: ids[0]! })] : [],
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
        return { body: { sessions: ids.map((id) => sessionSummary({ id })) } };
      }
      if (url.startsWith("/api/sessions?")) {
        baseCalls += 1;
        if (phase !== "initial" && baseCalls > 1) preserving = true;
        return {
          body: {
            sessions: [sessionSummary({ id: "confirmed-base" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "confirmed-base",
        "pinned-0",
      ]),
    );

    phase = "failing";
    socket.emit({
      type: "message_start",
      sessionId: "live-1",
      sessionStatus: { runState: "running" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    socket.emit({
      type: "agent_settled",
      sessionId: "live-2",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListError).toContain(
        "second id chunk unavailable",
      ),
    );

    expect(preserveChunks).toEqual([600, 1]);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "confirmed-base",
      "pinned-0",
    ]);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListOperation: "preserve",
    });

    phase = "retry";
    preserving = false;
    preserveChunks.length = 0;
    await store.retrySessionList();
    expect(preserveChunks).toEqual([600, 1]);
    expect(store.getState().sessions).toHaveLength(603);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListError: null,
    });
  });

  it("routes hydration authentication loss through the existing auth boundary", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: emptyBootstrap({
            ...bootstrapPayload().preferences,
            pinnedSessionIds: ["requires-auth"],
          }),
        };
      if (url.startsWith("/api/sessions/by-id")) {
        return { status: 401, body: { error: "token expired" } };
      }
      if (url.startsWith("/api/sessions?")) {
        return {
          body: {
            sessions: [sessionSummary({ id: "uncommitted-base" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store } = await initStore();

    await vi.waitFor(() => expect(store.getState().needsToken).toBe(true));
    expect(store.getState()).toMatchObject({
      connection: "offline",
      sessionListLoading: false,
      sessionListLoadingOlder: false,
      sessionListOperation: null,
    });
    expect(store.getState().sessions).toEqual([]);
  });

  it("retains confirmed folder hydration on cwd failure and retries it truthfully", async () => {
    let failCwd = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: emptyBootstrap({
            ...bootstrapPayload().preferences,
            pinnedProjectCwds: ["/work/pinned"],
          }),
        };
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions/by-cwd")) {
        expect(
          ((jsonBody(init).cwds as string[]) ?? []).length,
        ).toBeLessThanOrEqual(100);
        if (failCwd)
          return {
            status: 503,
            body: { error: "folder hydration unavailable" },
          };
        return {
          body: {
            sessions: [
              sessionSummary({ id: "folder-row", cwd: "/work/pinned" }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions?"))
        return {
          body: {
            sessions: [sessionSummary({ id: "base-row" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "base-row",
        "folder-row",
      ]),
    );

    failCwd = true;
    socket.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListError).toContain(
        "folder hydration unavailable",
      ),
    );
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "base-row",
      "folder-row",
    ]);
    expect(store.getState().sessionListOperation).toBe("preserve");

    failCwd = false;
    await store.retrySessionList();
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "base-row",
      "folder-row",
    ]);
    expect(store.getState().sessionListError).toBeNull();
  });

  it("retries a failed 80-row settlement refresh with the same preserved extent", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `session-${index}`);
    let preserving = false;
    let failPreserve = true;
    const preserveRequests: Array<[number, number]> = [];
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        if (preserving) {
          preserveRequests.push([offset, limit]);
          if (failPreserve)
            return {
              status: 503,
              body: { error: "settlement refresh failed" },
            };
        }
        return {
          body: {
            sessions: ids
              .slice(offset, offset + limit)
              .map((id) => sessionSummary({ id })),
            total: ids.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    await store.loadOlderSessions();
    expect(store.getState().sessionListNextOffset).toBe(80);

    preserving = true;
    socket.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListError).toBe(
        "settlement refresh failed",
      ),
    );
    expect(store.getState().sessions).toHaveLength(80);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 80,
      sessionListOperation: "preserve",
    });

    failPreserve = false;
    await store.retrySessionList();
    expect(preserveRequests).toEqual([
      [0, 80],
      [0, 80],
    ]);
    expect(store.getState().sessions).toHaveLength(80);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 80,
      sessionListError: null,
    });
  });

  it("atomically retries a preserved extent beyond the 100-row server page cap", async () => {
    const oldIds = Array.from({ length: 300 }, (_, index) => `old-${index}`);
    const refreshedIds = Array.from(
      { length: 300 },
      (_, index) => `fresh-${index}`,
    );
    let preserving = false;
    let failMiddle = true;
    const preserveRequests: Array<[number, number]> = [];
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        if (preserving) {
          preserveRequests.push([offset, limit]);
          if (failMiddle && offset === 100) {
            return {
              status: 503,
              body: { error: "middle preservation page failed" },
            };
          }
        }
        const source = preserving ? refreshedIds : oldIds;
        return {
          body: {
            sessions: source
              .slice(offset, offset + limit)
              .map((id) => sessionSummary({ id })),
            total: source.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    for (let index = 0; index < 5; index += 1) await store.loadOlderSessions();
    expect(store.getState().sessionListNextOffset).toBe(240);
    expect(store.getState().sessions.at(-1)?.id).toBe("old-239");

    preserving = true;
    socket.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListError).toContain(
        "middle preservation page failed",
      ),
    );
    expect(store.getState().sessions[0]?.id).toBe("old-0");
    expect(store.getState().sessions.at(-1)?.id).toBe("old-239");
    expect(store.getState().sessionListNextOffset).toBe(240);

    failMiddle = false;
    preserveRequests.length = 0;
    await store.retrySessionList();
    expect(preserveRequests).toEqual([
      [0, 100],
      [100, 100],
      [200, 40],
    ]);
    expect(preserveRequests.every(([, limit]) => limit <= 100)).toBe(true);
    expect(store.getState().sessions[0]?.id).toBe("fresh-0");
    expect(store.getState().sessions.at(-1)?.id).toBe("fresh-239");
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListError: null,
    });
  });

  it("stops and discards a multi-page preservation generation superseded mid-sequence", async () => {
    const ids = Array.from({ length: 260 }, (_, index) => `old-${index}`);
    let preserving = false;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const preserveOffsets: number[] = [];
    installFetch(async (url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const query = parsed.searchParams.get("q") ?? "";
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        if (query === "new-query")
          return {
            body: {
              sessions: [sessionSummary({ id: "new-result" })],
              total: 1,
              offset: 0,
              limit,
            },
          };
        if (preserving) {
          preserveOffsets.push(offset);
          if (offset === 100) {
            secondStarted();
            await secondGate;
          }
        }
        return {
          body: {
            sessions: ids
              .slice(offset, offset + limit)
              .map((id) => sessionSummary({ id })),
            total: ids.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );
    for (let index = 0; index < 5; index += 1) await store.loadOlderSessions();
    expect(store.getState().sessionListNextOffset).toBe(240);

    preserving = true;
    socket.emit({
      type: "agent_settled",
      sessionId: "background",
      sessionStatus: { runState: "idle" },
    });
    await started;
    await store.loadSessions("new-query");
    releaseSecond();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "new-result",
    ]);

    expect(preserveOffsets).toEqual([0, 100]);
    expect(store.getState()).toMatchObject({
      sessionQuery: "new-query",
      sessionListNextOffset: 1,
      sessionListTotal: 1,
      sessionListError: null,
    });
  });

  it("retries only failed live-session hydration while preserving 240 loaded rows", async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `base-${index}`);
    let hydrationAttempts = 0;
    let listRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id")) {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1)
          return { status: 503, body: { error: "live hydration unavailable" } };
        const requested = (jsonBody(init).ids as string[]) ?? [];
        return {
          body: {
            sessions: requested.map((id) =>
              sessionSummary({ id, cwd: "/work/live" }),
            ),
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        const parsed = new URL(url, "http://local");
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        return {
          body: {
            sessions: ids
              .slice(offset, offset + limit)
              .map((id) => sessionSummary({ id })),
            total: ids.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
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

    socket.emit({
      type: "message_start",
      sessionId: "live-session",
      sessionStatus: { runState: "running" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListError).toContain(
        "live hydration unavailable",
      ),
    );
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListTotal: 300,
      sessionListOperation: "hydrate",
      sessionListHydrating: false,
    });
    expect(store.getState().sessions).toHaveLength(240);

    await store.retrySessionList();
    expect(hydrationAttempts).toBe(2);
    expect(listRequests).toBe(6);
    expect(store.getState().sessions).toHaveLength(241);
    expect(store.getState().sessions.at(-1)?.id).toBe("live-session");
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 240,
      sessionListTotal: 300,
      sessionListOperation: null,
      sessionListHydrating: false,
      sessionListError: null,
    });
  });

  it("routes standalone live hydration 401 through auth loss without changing loaded pages", async () => {
    const ids = Array.from({ length: 80 }, (_, index) => `base-${index}`);
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id"))
        return { status: 401, body: { error: "expired" } };
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 40);
        return {
          body: {
            sessions: ids
              .slice(offset, offset + limit)
              .map((id) => sessionSummary({ id })),
            total: ids.length,
            offset,
            limit,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListNextOffset).toBe(40),
    );

    socket.emit({
      type: "message_start",
      sessionId: "auth-live",
      sessionStatus: { runState: "running" },
    });
    await vi.waitFor(() => expect(store.getState().needsToken).toBe(true));
    expect(store.getState().sessions).toHaveLength(40);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 40,
      sessionListTotal: 80,
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListError: null,
    });
  });

  it("discards a hydration-only retry superseded by a query generation", async () => {
    let hydrationAttempts = 0;
    let releaseRetry!: () => void;
    let retryStarted!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: emptyBootstrap() };
      if (url.startsWith("/api/sessions/by-id")) {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1)
          return { status: 503, body: { error: "retry me" } };
        retryStarted();
        await retryGate;
        const requested = (jsonBody(init).ids as string[]) ?? [];
        return {
          body: { sessions: requested.map((id) => sessionSummary({ id })) },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        const parsed = new URL(url, "http://local");
        const query = parsed.searchParams.get("q") ?? "";
        return {
          body: {
            sessions: [sessionSummary({ id: query ? "query-result" : "base" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const { store, socket } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions[0]?.id).toBe("base"),
    );

    socket.emit({
      type: "message_start",
      sessionId: "stale-live",
      sessionStatus: { runState: "running" },
    });
    await vi.waitFor(() =>
      expect(store.getState().sessionListOperation).toBe("hydrate"),
    );
    const retry = store.retrySessionList();
    await started;
    await store.loadSessions("needle");
    releaseRetry();
    await retry;

    expect(hydrationAttempts).toBe(2);
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "query-result",
    ]);
    expect(store.getState()).toMatchObject({
      sessionQuery: "needle",
      sessionListNextOffset: 1,
      sessionListTotal: 1,
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListError: null,
    });
  });
});
