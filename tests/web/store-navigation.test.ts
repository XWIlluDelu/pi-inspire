// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCatalog, sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
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
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      if (url === "/api/sessions/new") creating();
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await expect(store.newSession()).resolves.toBeNull();
    expect(creating).not.toHaveBeenCalled();
    expect(store.getState().notices.at(-1)).toMatchObject({
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
  const curationRoutes =
    (refused = false): RouteHandler =>
    (url, init) => {
      if (url === "/api/preferences" && init.method === "PATCH")
        return refused
          ? { status: 500, body: { error: "preference write rejected" } }
          : patchPreferences(init);
      if (url.startsWith("/api/sessions?"))
        return {
          body: sessionPage(
            [sessionSummary({ id: "s7", title: "Pin target" })],
            1,
          ),
        };
      return baseRoutes(url, init);
    };

  const recent = sessionSummary({ id: "recent", cwd: "/work/other" });
  const folder = sessionSummary({ id: "off-page", cwd: "/work/demo" });
  const sessionIds = (store: Awaited<ReturnType<typeof initStore>>["store"]) =>
    store.getState().sessions.map(({ id }) => id);

  it("prunes a restored off-page row after confirmation without refetching the catalog", async () => {
    const write = deferred<void>();
    let lists = 0;
    installCatalog(
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
    const { store } = await initStore();
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
    installCatalog(() => ({ body: sessionPage([recent], 2) }), {
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
    });
    const { store } = await initStore();
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

  it.each([false, true])(
    "hydrates the confirmed curated folder without replacing the chronological list (refused removal=%s)",
    async (refuseRemoval) => {
      const hydration = deferred<void>();
      const requested = deferred<void>();
      let lists = 0;
      let writes = 0;
      installCatalog(
        () => {
          lists++;
          return { body: sessionPage([recent], 8) };
        },
        {
          routes: async (url, init) => {
            if (url === "/api/preferences") {
              if (++writes === 2)
                return { status: 500, body: { error: "removal rejected" } };
              return patchPreferences(init);
            }
            if (url === "/api/sessions/by-cwd") {
              requested.resolve();
              await hydration.promise;
              return { body: { sessions: [folder] } };
            }
          },
        },
      );
      const { store } = await initStore();
      await vi.waitFor(() => expect(sessionIds(store)).toEqual([recent.id]));
      store.toggleProjectHidden(folder.cwd);
      if (refuseRemoval) {
        store.toggleProjectHidden(folder.cwd);
        expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);
      }
      await requested.promise;
      await vi.waitFor(() =>
        expect(store.getState().prefs.hiddenProjectCwds).toEqual([folder.cwd]),
      );
      expect(store.getState()).toMatchObject({
        sessionListLoading: false,
        sessionListNextOffset: 1,
        sessionListTotal: 8,
      });
      hydration.resolve();
      await vi.waitFor(() =>
        expect(sessionIds(store)).toEqual([recent.id, folder.id]),
      );
      expect(lists).toBe(1);
    },
  );

  it("rolls a refused curation write back and reports it", async () => {
    installFetch(curationRoutes(true));
    const { store } = await initStore();

    store.toggleSessionPin("s7");
    expect(store.getState().prefs.pinnedSessionIds).toEqual(["s7"]);

    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .notices.some(
            (notice) =>
              notice.kind === "warning" &&
              notice.text === "preference write rejected",
          ),
      ).toBe(true),
    );
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
  });

  it("keeps a pending preference visible across transport replacement and rolls back to the new host baseline", async () => {
    const pendingPatch = deferred<RouteResponse>();
    const { promise: started, resolve: patchStarted } = deferred<void>();
    let theme: "light" | "system" = "system";
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: {
              ...DEFAULT_PREFS,
              theme,
            },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        patchStarted();
        return pendingPatch.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    await started;
    theme = "light";
    await store.init();
    expect(store.getState().prefs.theme).toBe("dark");

    pendingPatch.resolve({
      status: 500,
      body: { error: "preference write rejected" },
    });
    await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("light"));
  });

  it("keeps the newest owner when a refused preference write has the same value", async () => {
    let writes = 0;
    const patches: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        writes += 1;
        patches.push(jsonBody(init));
        if (writes === 1) {
          return { status: 500, body: { error: "preference write rejected" } };
        }
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      }
      return curationRoutes()(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    store.setTheme("light");
    store.setTheme("dark");
    await vi.waitFor(() => expect(patches).toHaveLength(3));

    expect(store.getState().prefs.theme).toBe("dark");
  });

  it("retries a child restore when the hidden folder's membership becomes available", async () => {
    const cwd = "/work/hidden";
    const child = sessionSummary({ id: "child", cwd, title: "Restore me" });
    const sibling = sessionSummary({ id: "sibling", cwd });
    let failLookup = false;
    installCatalog(() => ({ body: sessionPage([child], 1) }), {
      preferences: { hiddenProjectCwds: [cwd] },
      routes: (url, init) => {
        if (url === "/api/sessions/by-cwd")
          return failLookup
            ? { status: 503, body: { error: "Folder lookup failed" } }
            : { body: { sessions: [child, sibling] } };
        if (url === "/api/preferences") return patchPreferences(init);
      },
    });
    const { store } = await initStore();
    await store.loadSessions("Restore me");
    expect(sessionIds(store)).toEqual([child.id]);

    failLookup = true;
    store.toggleSessionHidden(child.id);
    await vi.waitFor(() =>
      expect(store.getState().notices.at(-1)?.text).toBe(
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

  it("adopts untouched authoritative fields as the rollback baseline for successive refusals", async () => {
    let writes = 0;
    installFetch((url, init) => {
      if (url === "/api/preferences" && init.method === "PATCH") {
        if (++writes > 1)
          return { status: 500, body: { error: "preference write rejected" } };
        return {
          body: { ...patchPreferences(init).body, palette: "hydrangea" },
        };
      }
      return curationRoutes()(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    await vi.waitFor(() =>
      expect(store.getState().prefs.palette).toBe("hydrangea"),
    );
    store.setPalette("chimonanthus");
    store.setPalette("lycoris");
    expect(store.getState().prefs.palette).toBe("lycoris");
    await vi.waitFor(() =>
      expect(store.getState().prefs.palette).toBe("hydrangea"),
    );
    expect(store.getState().error).toBeNull();
    expect(store.getState().notices.at(-1)).toMatchObject({
      kind: "warning",
      text: "preference write rejected",
    });
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
    const { store, socket } = await initStore();

    const renaming = store.renameSession("s1", "Renamed A");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
    });
    releaseRename();
    await expect(renaming).resolves.toBe(true);
    expect(renameBody).toEqual({ sessionId: "s1", name: "Renamed A" });
    // The rename belonged to s1; the visible title of s2 stays truthful.
    expect(store.getState().sessionName).toBe("Session B");
  });
});

describe("selection race ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("an authoritative push invalidates an in-flight open response", async () => {
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
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s-B", sessionName: "B" }),
    });
    expect(store.getState().sessionId).toBe("s-B");
    releaseOpen();
    await opening;
    expect(store.getState().sessionId).toBe("s-B");
  });
});
