// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCatalog, sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  emptySnapshot,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  selectSession,
  sessionSummary,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("session switching guard", () => {
  beforeEach(() => installFakeWebSocket());

  it.each([
    [404, "Session not found"],
    [409, "Session is owned by another Pi process"],
  ] as const)(
    "reports a refused selection (%s) and lets the user select again",
    async (status, error) => {
      const visible = sessionSummary({ id: "s1" });
      const target = sessionSummary({ id: "s9" });
      let missing = false;
      installFetch((url, init) => {
        if (url === "/api/sessions/open") {
          if (jsonBody(init).id === target.id) {
            missing = status === 404;
            return {
              status,
              body: {
                error,
                ...(missing ? { code: "SESSION_NOT_FOUND" } : {}),
              },
            };
          }
          return { body: activeSnapshot({ sessionId: "s3" }) };
        }
        if (url.startsWith("/api/sessions?")) {
          const sessions = missing ? [visible] : [visible, target];
          return { body: sessionPage(sessions, sessions.length) };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));
      await store.openSession(target.id);
      expect(store.getState()).toMatchObject({
        sessionId: "s1",
        openingSessionId: null,
        error: null,
        sessionActionError: error,
      });
      await vi.waitFor(() =>
        expect(store.getState().sessions.map(({ id }) => id)).toEqual(
          missing ? ["s1"] : ["s1", "s9"],
        ),
      );
      await store.openSession("s3");
      expect(store.getState()).toMatchObject({
        sessionId: "s3",
        error: null,
        sessionActionError: null,
      });
    },
  );

  it("requires a workspace before dispatching session creation", async () => {
    const creating = vi.fn();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload(),
        };
      if (url === "/api/sessions/new") creating();
      return baseRoutes(url, init);
    });
    const { store } = await initStore(emptySnapshot);
    await expect(store.newSession()).resolves.toBeNull();
    expect(creating).not.toHaveBeenCalled();
    expect(store.getState().live.notices.at(-1)).toMatchObject({
      kind: "warning",
      text: "Enter a project directory to start a session",
    });
  });
});

describe("navigation curation", () => {
  beforeEach(() => installFakeWebSocket());

  const patchPreferences = (init: RequestInit) => ({
    body: { ...DEFAULT_PREFS, ...jsonBody(init) },
  });
  const recent = sessionSummary({ id: "recent", cwd: "/work/other" });
  const folder = sessionSummary({ id: "off-page", cwd: "/work/demo" });
  const sessionIds = (store: Awaited<ReturnType<typeof initStore>>["store"]) =>
    store.getState().sessions.map(({ id }) => id);

  it("prunes a restored off-page row after confirmation without refetching the catalog", async () => {
    const write = deferred<void>();
    let lists = 0;
    const { store } = await installCatalog(
      () => {
        lists++;
        return { body: sessionPage([recent], 2) };
      },
      {
        preferences: { hiddenSessionIds: [folder.id] },
        routes: async (url, init) => {
          if (url === "/api/sessions/by-id")
            return { body: { sessions: [folder] } };
          if (url === "/api/preferences") {
            await write.promise;
            return patchPreferences(init);
          }
        },
      },
    );
    await vi.waitFor(() =>
      expect(sessionIds(store)).toEqual([recent.id, folder.id]),
    );

    store.toggleSessionHidden(folder.id);
    expect(sessionIds(store)).toContain(folder.id);
    write.resolve();
    await vi.waitFor(() => expect(sessionIds(store)).toEqual([recent.id]));
    expect(lists).toBe(1);
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListTotal: 2,
    });
  });

  it("does not revive rows from a catalog refresh that captured older curation", async () => {
    const delayed = deferred<void>();
    const started = deferred<void>();
    let folderReads = 0;
    const { store } = await installCatalog(
      () => ({ body: sessionPage([recent], 2) }),
      {
        preferences: { hiddenProjectCwds: [folder.cwd] },
        routes: async (url, init) => {
          if (url === "/api/preferences") return patchPreferences(init);
          if (url === "/api/sessions/refresh") return { body: { ok: true } };
          if (url === "/api/sessions/by-cwd") {
            if (++folderReads === 2) {
              started.resolve();
              await delayed.promise;
            }
            return { body: { sessions: [folder] } };
          }
        },
      },
    );
    await vi.waitFor(() =>
      expect(sessionIds(store)).toEqual([recent.id, folder.id]),
    );
    const refresh = store.refreshSessions();
    await started.promise;
    store.toggleProjectHidden(folder.cwd);
    await vi.waitFor(() => expect(sessionIds(store)).toEqual([recent.id]));
    delayed.resolve();
    await refresh;
    expect(sessionIds(store)).toEqual([recent.id]);
  });

  it("hydrates the confirmed curated folder without replacing the chronological list", async () => {
    let lists = 0;
    const { store } = await installCatalog(
      () => {
        lists++;
        return { body: sessionPage([recent], 8) };
      },
      {
        routes: (url, init) => {
          if (url === "/api/preferences") return patchPreferences(init);
          if (url === "/api/sessions/by-cwd")
            return { body: { sessions: [folder] } };
        },
      },
    );
    await vi.waitFor(() => expect(sessionIds(store)).toEqual([recent.id]));
    store.toggleProjectHidden(folder.cwd);
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);
    await vi.waitFor(() =>
      expect(sessionIds(store)).toEqual([recent.id, folder.id]),
    );
    expect(store.getState()).toMatchObject({
      prefs: { hiddenProjectCwds: [folder.cwd] },
      sessionListLoading: false,
      sessionListNextOffset: 1,
      sessionListTotal: 8,
    });
    expect(lists).toBe(1);
  });

  it("does not publish a refused curation write", async () => {
    const { store } = await installCatalog(
      () => ({ body: sessionPage([recent], 1) }),
      {
        routes: (url) =>
          url === "/api/preferences"
            ? { status: 409, body: { error: "preference write rejected" } }
            : undefined,
      },
    );
    store.toggleSessionPin(recent.id);
    expect(store.getState()).toMatchObject({
      prefs: { pinnedSessionIds: [] },
      curationPending: true,
    });
    await vi.waitFor(() =>
      expect(store.getState().curationPending).toBe(false),
    );
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
    expect(store.getState().live.notices.at(-1)?.text).toBe(
      "preference write rejected",
    );
  });

  it("keeps the replacement Host's baseline when an older write returns", async () => {
    const oldWrite = deferred<RouteResponse>();
    const started = deferred<void>();
    let replaced = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload(
            replaced
              ? {
                  authorityId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
                  preferences: { ...DEFAULT_PREFS, theme: "light" },
                  preferenceRevision: 1,
                }
              : {},
          ),
        };
      if (url === "/api/preferences") {
        started.resolve();
        return oldWrite.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    store.setPreference("theme", "dark");
    await started.promise;
    replaced = true;
    await store.init();
    expect(store.getState().desiredPreferences).toEqual({});
    oldWrite.resolve({
      body: { preferences: { ...DEFAULT_PREFS, theme: "dark" }, revision: 500 },
    });
    await oldWrite.promise;
    expect(store.getState().prefs.theme).toBe("light");
  });

  it("reads a same-Host write that settles after bootstrap without replaying it", async () => {
    const write = deferred<void>();
    const started = deferred<void>();
    let writes = 0;
    let theme = DEFAULT_PREFS.theme;
    installFetch(async (url, init) => {
      if (url === "/api/bootstrap")
        return {
          body: bootstrapPayload({ preferences: { ...DEFAULT_PREFS, theme } }),
        };
      if (url !== "/api/preferences") return baseRoutes(url, init);
      if (init.method === "PATCH") {
        writes++;
        started.resolve();
        await write.promise;
        theme = "dark";
      }
      return { body: { ...DEFAULT_PREFS, theme } };
    });
    const { store } = await initStore();
    store.setPreference("theme", "dark");
    await started.promise;
    await store.init();
    expect(store.getState().prefs.theme).toBe("system");
    write.resolve();
    await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("dark"));
    expect(writes).toBe(1);
  });

  it("retries a child restore when the hidden folder's membership becomes available", async () => {
    const cwd = "/work/hidden";
    const child = sessionSummary({ id: "child", cwd, title: "Restore me" });
    const sibling = sessionSummary({ id: "sibling", cwd });
    let failLookup = false;
    const { store } = await installCatalog(
      () => ({ body: sessionPage([child], 1) }),
      {
        preferences: { hiddenProjectCwds: [cwd] },
        routes: (url, init) => {
          if (url === "/api/sessions/by-cwd")
            return failLookup
              ? { status: 503, body: { error: "Folder lookup failed" } }
              : { body: { sessions: [child, sibling] } };
          if (url === "/api/preferences") return patchPreferences(init);
        },
      },
    );
    await store.loadSessions("Restore me");
    expect(sessionIds(store)).toEqual([child.id]);

    failLookup = true;
    store.toggleSessionHidden(child.id);
    await vi.waitFor(() =>
      expect(store.getState().live.notices.at(-1)?.text).toBe(
        "Folder lookup failed",
      ),
    );
    expect(store.getState().prefs).toMatchObject({
      hiddenProjectCwds: [cwd],
      hiddenSessionIds: [],
    });

    failLookup = false;
    store.toggleSessionHidden(child.id);
    await vi.waitFor(() =>
      expect(store.getState().prefs).toMatchObject({
        hiddenProjectCwds: [],
        hiddenSessionIds: [sibling.id],
      }),
    );
  });
});

describe("async completion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("a delayed rename response cannot retitle a different session", async () => {
    const { promise: renameGate, resolve: releaseRename } = deferred<void>();
    let renameBody: Record<string, unknown> | null = null;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/rename")) {
        renameBody = jsonBody(init);
        await renameGate;
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const renaming = store.renameSession("s1", "Renamed A");
    await selectSession(
      store,
      activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
    );
    releaseRename();
    await expect(renaming).resolves.toBe(true);
    expect(renameBody).toEqual({ sessionId: "s1", name: "Renamed A" });
    // The rename belonged to s1; the visible title of s2 stays truthful.
    expect(store.getState().sessionName).toBe("Session B");
  });
});

describe("selection race ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("an addressed refresh preserves a newer explicit selection", async () => {
    const { promise: openGate, resolve: releaseOpen } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/sessions/open")) {
        await openGate;
        return { body: activeSnapshot({ sessionId: "s-A", sessionName: "A" }) };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const opening = store.openSession("s-A");
    socket.emitSnapshot(activeSnapshot({ sessionName: "Refreshed" }));
    expect(store.getState()).toMatchObject({
      sessionName: "Refreshed",
      openingSessionId: "s-A",
    });
    releaseOpen();
    await opening;
    expect(store.getState().sessionId).toBe("s-A");
  });
});
