// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
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

  it("clears the pending state and surfaces the error when the open fails", async () => {
    installFetch(baseRoutes);
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          return new Response(
            JSON.stringify({ error: "session is owned by another Pi process" }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 404,
        });
      }),
    );

    await store.openSession("s9");
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().sessionId).toBe("s1"); // active session unchanged
    expect(store.getState().error).toBeNull();
    expect(store.getState().sessionActionError).toBe(
      "session is owned by another Pi process",
    );

    // a later selection is not blocked by the failed attempt
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/sessions/open")) {
          return new Response(
            JSON.stringify(activeSnapshot({ sessionId: "s3" })),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 404,
        });
      }),
    );
    await store.openSession("s3");
    expect(store.getState().sessionId).toBe("s3");
    expect(store.getState().error).toBeNull();
  });
});

describe("navigation curation", () => {
  beforeEach(() => installFakeWebSocket());

  const curationRoutes = (
    patchBehavior: "ok" | "fail",
    onPatch?: (patch: Record<string, unknown>) => void,
  ): RouteHandler => {
    return (url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        onPatch?.(patch);
        if (patchBehavior === "fail")
          return { status: 500, body: { error: "preference write rejected" } };
        return { body: { ...bootstrapPayload().preferences, ...patch } };
      }
      if (url.startsWith("/api/sessions")) {
        return {
          body: {
            sessions: [
              {
                id: "s7",
                cwd: "/demo",
                project: "demo",
                title: "Pin target",
                created: "2026-07-20T10:00:00Z",
                modified: "2026-07-21T10:00:00Z",
                messageCount: 2,
              },
            ],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    };
  };

  it("retains an off-page curated row until restore is confirmed, then prunes it without a list reload", async () => {
    let listRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenSessionIds: ["off-page"],
            },
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-id")) {
        return {
          body: {
            sessions: [
              sessionSummary({ id: "off-page", cwd: "/work/archived" }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "off-page",
      ]),
    );

    store.toggleSessionHidden("off-page");
    expect(store.getState().sessions.map((session) => session.id)).toContain(
      "off-page",
    );
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
      ]),
    );
    expect(listRequests).toBe(1);
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListHydrating: false,
      sessionListNextOffset: 1,
      sessionListTotal: 2,
    });
  });

  it("does not revive rows from a catalog refresh that captured older curation", async () => {
    let folderRequests = 0;
    const { promise: refreshHydrationGate, resolve: releaseRefreshHydration } =
      deferred<void>();
    const {
      promise: refreshHydrationRequest,
      resolve: refreshHydrationStarted,
    } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenProjectCwds: ["/work/demo"],
            },
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/refresh")) {
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderRequests += 1;
        if (folderRequests === 2) {
          refreshHydrationStarted();
          await refreshHydrationGate;
        }
        return {
          body: {
            sessions: [sessionSummary({ id: "off-page", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "off-page",
      ]),
    );

    const refresh = store.refreshSessions();
    await refreshHydrationRequest;
    store.toggleProjectHidden("/work/demo");
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
      ]),
    );

    releaseRefreshHydration();
    await refresh;
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "recent",
    ]);
  });

  it("hydrates a newly curated folder without resetting or foregrounding the chronological list", async () => {
    let listRequests = 0;
    const { promise: folderGate, resolve: releaseFolder } = deferred<void>();
    const { promise: folderRequest, resolve: folderStarted } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderStarted();
        await folderGate;
        return {
          body: {
            sessions: [sessionSummary({ id: "folder-old", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent", cwd: "/work/other" })],
            total: 8,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(false),
    );

    store.toggleProjectHidden("/work/demo");
    await folderRequest;
    expect(store.getState()).toMatchObject({
      sessionListLoading: false,
      sessionListHydrating: true,
      sessionListOperation: "curation",
      sessionListNextOffset: 1,
      sessionListTotal: 8,
    });
    expect(listRequests).toBe(1);

    releaseFolder();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "folder-old",
      ]),
    );
    expect(store.getState()).toMatchObject({
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListNextOffset: 1,
      sessionListTotal: 8,
    });
    expect(listRequests).toBe(1);
  });

  it("hydrates confirmed curation restored after a newer queued removal is refused", async () => {
    let listRequests = 0;
    let folderRequests = 0;
    let preferenceWrites = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        preferenceWrites += 1;
        if (preferenceWrites === 2) {
          return { status: 500, body: { error: "removal rejected" } };
        }
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        folderRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "folder-old", cwd: "/work/demo" })],
          },
        };
      }
      if (url.startsWith("/api/sessions?")) {
        listRequests += 1;
        return {
          body: {
            sessions: [sessionSummary({ id: "recent" })],
            total: 2,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessionListLoading).toBe(false),
    );

    store.toggleProjectHidden("/work/demo");
    store.toggleProjectHidden("/work/demo");
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);

    await vi.waitFor(() =>
      expect(store.getState().prefs.hiddenProjectCwds).toEqual(["/work/demo"]),
    );
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "folder-old",
      ]),
    );
    expect(folderRequests).toBeGreaterThanOrEqual(1);
    expect(listRequests).toBe(1);
  });

  it("rolls a refused curation write back and reports it", async () => {
    installFetch(curationRoutes("fail"));
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
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        const token = new Headers(init.headers).get("authorization");
        return {
          body: bootstrapPayload({
            preferences: {
              ...DEFAULT_PREFS,
              theme: token === "Bearer fresh" ? "light" : "system",
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
    await store.init("fresh");
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
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    store.setTheme("light");
    store.setTheme("dark");
    await vi.waitFor(() => expect(patches).toHaveLength(3));

    expect(store.getState().prefs.theme).toBe("dark");
  });

  it("fetches pinned and hidden sessions missing from the first page", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              pinnedSessionIds: ["s-pinned"],
              hiddenSessionIds: ["s-hidden"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-id")) {
        const body = jsonBody(init) as { ids: string[] };
        // Hidden sessions hydrate too: the Hidden group is what makes hiding
        // reversible, so its rows cannot depend on the first catalog page.
        expect(body.ids).toEqual(["s-pinned", "s-hidden", "s1"]);
        return {
          body: {
            sessions: body.ids.map((id) => ({
              id,
              cwd: "/elsewhere",
              project: "elsewhere",
              title: `Off-page ${id}`,
              created: "2026-07-19T10:00:00Z",
              modified: "2026-07-19T11:00:00Z",
              messageCount: 5,
            })),
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => {
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "s-pinned",
        "s-hidden",
        "s1",
      ]);
    });
  });

  it("fetches a pinned folder whose sessions all fall outside the first page", async () => {
    let byCwdRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              pinnedProjectCwds: ["/work/pinned-folder"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        byCwdRequests += 1;
        expect(jsonBody(init)).toEqual({ cwds: ["/work/pinned-folder"] });
        // A folder pin claims the whole folder, so its rows arrive by cwd
        // rather than depending on which of them are recent enough to page in.
        return {
          body: {
            sessions: ["old-a", "old-b"].map((id) => ({
              id,
              cwd: "/work/pinned-folder",
              project: "pinned-folder",
              title: `Archived ${id}`,
              created: "2026-01-02T10:00:00Z",
              modified: "2026-01-02T11:00:00Z",
              messageCount: 3,
            })),
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        // The newest page holds nothing from that folder at all.
        return {
          body: {
            sessions: [sessionSummary({ id: "recent", cwd: "/work/other" })],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => {
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "recent",
        "old-a",
        "old-b",
      ]);
    });
    expect(byCwdRequests).toBe(1);
  });

  it("fetches a hidden folder by cwd so restoring it never depends on the first page", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              hiddenProjectCwds: ["/work/hidden-folder"],
            },
          }),
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        expect(jsonBody(init)).toEqual({ cwds: ["/work/hidden-folder"] });
        return {
          body: {
            sessions: [
              sessionSummary({ id: "hidden-old", cwd: "/work/hidden-folder" }),
            ],
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "hidden-old",
      ]),
    );
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([
      "/work/hidden-folder",
    ]);
  });

  it("restores the last confirmed value when two writes fail in a row", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        return { status: 500, body: { error: "preference write rejected" } };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().prefs.theme).toBe("system");

    store.setTheme("dark");
    store.setTheme("light");

    // Neither write reached disk, so the surviving value has to be the one the
    // host still holds — not "dark", which was only ever a local optimism.
    await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("system"));
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" &&
            notice.text === "preference write rejected",
        ),
    ).toBe(true);
  });

  it("adopts untouched authoritative fields as the next rollback baseline", async () => {
    let writes = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        writes += 1;
        if (writes === 2)
          return { status: 500, body: { error: "preference write rejected" } };
        return {
          body: {
            ...bootstrapPayload().preferences,
            ...jsonBody(init),
            palette: "teal",
          },
        };
      }
      return curationRoutes("ok")(url, init);
    });
    const { store } = await initStore();

    store.setTheme("dark");
    await vi.waitFor(() => expect(store.getState().prefs.palette).toBe("teal"));

    store.setPalette("amber");
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .notices.some(
            (notice) => notice.text === "preference write rejected",
          ),
      ).toBe(true),
    );
    expect(store.getState().prefs.palette).toBe("teal");
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

  it("a failed thinking-level change does not roll back over another session", async () => {
    const { promise: gate, resolve: releaseThinking } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/control/thinking")) {
        await gate;
        return { status: 500, body: { error: "unsupported level" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const changing = store.setThinkingLevel("high"); // optimistic on s1, gated
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "s2",
        sessionName: "B",
        thinkingLevel: "low",
      }),
    });
    expect(store.getState().thinkingLevel).toBe("low");

    releaseThinking();
    await changing;
    // The rollback belonged to s1; s2's visible level stays truthful.
    expect(store.getState().thinkingLevel).toBe("low");
  });
});
