// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { baseRoutes, initStore, installStoreRoutes } from "./store-fixture";

function committed(sessionId: string, preferences = DEFAULT_PREFS) {
  return {
    deleted: [{ sessionId, disposition: "trashed" as const }],
    navigation: {
      kind: "confirmed" as const,
      authorityId: TEST_HOST_AUTHORITY,
      revision: 1_000_000,
      preferences,
    },
  };
}

describe("session deletion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("applies a committed deletion even when confirmed curation could not be saved", async () => {
    const preferences = { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] };
    const remove = vi.fn(() => ({
      body: {
        deleted: [{ sessionId: "s2", disposition: "trashed" }],
        navigation: {
          kind: "unavailable",
          reason: "Deletion metadata could not be saved",
        },
      },
    }));
    installStoreRoutes((url) => {
      if (url === "/api/bootstrap")
        return {
          body: bootstrapPayload({ startupSessionId: "s1", preferences }),
        };
      if (url === "/api/sessions/delete") return remove();
    });
    const { store } = await initStore();
    store.drafts.setText("s2", "discard deleted draft");
    await expect(store.deleteSession("s2")).resolves.toBe("trashed");
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]);
    expect(store.drafts.get("s2").text).toBe("");
    expect(store.getState().live.notices.at(-1)?.text).toContain(
      "metadata could not be saved",
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(["expanded", "empty"] as const)(
    "refreshes %s Hidden membership without repeating deletion or losing a concurrent preference",
    async (change) => {
      let ids = ["s1", "s2"];
      const preferenceRead = deferred<{
        preferences: typeof DEFAULT_PREFS;
        revision: number;
      }>();
      const refreshed = vi.fn();
      const submitted = vi.fn();
      let preferences = { ...DEFAULT_PREFS, hiddenSessionIds: ids };
      let revision = 10;
      const publish = () => ({ preferences, revision: ++revision });
      installStoreRoutes((url, init) => {
        if (url === "/api/bootstrap")
          return {
            body: bootstrapPayload({
              startupSessionId: "s1",
              preferences,
              preferenceRevision: revision,
            }),
          };
        if (url === "/api/preferences") {
          if (init.method !== "PATCH")
            return preferenceRead.promise.then((body) => ({ body }));
          preferences = { ...preferences, ...jsonBody(init) };
          return { body: publish() };
        }
        if (url === "/api/sessions/delete") {
          submitted(jsonBody(init));
          ids = change === "empty" ? [] : [...ids, "s3"];
          preferences = { ...preferences, hiddenSessionIds: ids };
          return {
            status: change === "empty" ? 404 : 409,
            body: { error: "Hidden changed", code: "HIDDEN_SELECTION_CHANGED" },
          };
        }
        if (url === "/api/sessions/refresh") {
          refreshed();
          return { body: { ok: true } };
        }
        const rows = ids.map((id) => sessionSummary({ id }));
        if (url === "/api/sessions/by-id") return { body: { sessions: rows } };
        if (url.startsWith("/api/sessions?"))
          return { body: sessionPage(rows, rows.length) };
      });
      const { store } = await initStore();
      await vi.waitFor(() =>
        expect(store.getState()).toMatchObject({
          sessionListLoading: false,
          sessionListHydrating: false,
          sessions: expect.arrayContaining([
            expect.objectContaining({ id: "s2" }),
          ]),
        }),
      );
      const pending = store.clearHiddenSessions(ids);
      await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
      const oldPublication = publish();
      store.setPreference("theme", "dark");
      await vi.waitFor(() => expect(preferences.theme).toBe("dark"));
      preferenceRead.resolve(oldPublication);
      await expect(pending).resolves.toBeNull();
      expect(store.getState().sessionDeleteReviewRequired).toBe(true);
      await store.clearHiddenSessions(ids);
      expect(submitted).toHaveBeenCalledExactlyOnceWith({
        scope: "hidden",
        sessionIds: ["s1", "s2"],
      });
      expect(store.getState().sessions.map(({ id }) => id)).toEqual(ids);
      expect(store.getState().prefs.hiddenSessionIds).toEqual(ids);
      expect(store.getState().prefs.theme).toBe("dark");
    },
  );

  it.each(["newer-selection", "opening"] as const)(
    "retains %s ownership when the previously visible session is deleted",
    async (outcome) => {
      const { promise: deleteGate, resolve: releaseDelete } = deferred<void>();
      const { promise: openGate, resolve: releaseOpen } = deferred<void>();
      const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
      let deleted = false;
      let requested = false;
      const fetch = installFetch(async (url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return {
            body: bootstrapPayload({
              startupSessionId: "s1",
              preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s1"] },
            }),
          };
        if (url === "/api/sessions/delete") {
          requested = true;
          await deleteGate;
          deleted = true;
          expect(jsonBody(init)).toEqual({ scope: "session", sessionId: "s1" });
          return { body: committed("s1") };
        }
        if (url === "/api/sessions/open") {
          if (outcome === "opening") await openGate;
          return { body: activeSnapshot({ sessionId: "s2" }) };
        }
        if (url.startsWith("/api/sessions/by-id"))
          return { body: { sessions: deleted ? [] : [rows[0]] } };
        if (url.startsWith("/api/sessions"))
          return {
            body: sessionPage(deleted ? [rows[1]!] : rows, deleted ? 1 : 2),
          };
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));
      socket.emit({
        type: "external_session_activity",
        activities: { s1: "idle" },
      });
      expect(store.getState().externalSessionActivities.s1).toBe("idle");
      store.drafts.setText("s1", "deleted draft");
      store.drafts.setText("s2", "keep this draft");
      const deleting = store.deleteSession("s1");
      await vi.waitFor(() => expect(requested).toBe(true));
      expect(store.getState().sessionId).toBe("s1");
      const opening = store.openSession("s2");
      if (outcome === "newer-selection") await opening;
      releaseDelete();
      await expect(deleting).resolves.toBe("trashed");
      if (outcome === "opening") {
        expect(store.getState().sessionSelectionPending).toBe(true);
        releaseOpen();
        await opening;
      }
      expect(store.getState()).toMatchObject({ sessionId: "s2" });
      expect(store.getState().sessionStatuses).not.toHaveProperty("s1");
      expect(store.getState().externalSessionActivities).not.toHaveProperty(
        "s1",
      );
      expect(store.drafts.get("s1").text).toBe("");
      expect(store.drafts.get("s2").text).toBe("keep this draft");
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes("/deselect")),
      ).toBe(false);
    },
  );

  it.each([
    { method: "delete", result: "committed" },
    { method: "delete", result: "refused" },
    { method: "clear", result: "partial" },
    { method: "delete", result: "unauthorized" },
  ] as const)(
    "fences old projection reads during $method and reconciles the $result result",
    async ({ method, result }) => {
      const oldRead = deferred<{ status: number; body: { error: string } }>();
      const deletion = deferred<void>();
      const requested = deferred<void>();
      const targets = result === "partial" ? ["s1", "s2"] : ["s1"];
      let sessions = [
        sessionSummary({ id: "s1" }),
        sessionSummary({ id: "s2" }),
      ];
      let reads = 0;
      installFetch(async (url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return {
            body: bootstrapPayload({
              startupSessionId: "s1",
              preferences: { ...DEFAULT_PREFS, hiddenSessionIds: targets },
            }),
          };
        if (url.startsWith("/api/snapshot")) {
          reads += 1;
          return reads === 1 ? oldRead.promise : { body: activeSnapshot() };
        }
        if (url === "/api/sessions/delete") {
          requested.resolve();
          await deletion.promise;
          if (result === "refused")
            return { status: 500, body: { error: "Trash unavailable" } };
          const sessionId = result === "partial" ? "s2" : "s1";
          sessions = sessions.filter((row) => row.id !== sessionId);
          return {
            body: {
              ...committed(sessionId),
              ...(result === "partial"
                ? { failure: { sessionId: "s1", message: "Trash unavailable" } }
                : {}),
            },
          };
        }
        if (url.startsWith("/api/sessions/by-id"))
          return { body: { sessions } };
        if (url.startsWith("/api/sessions"))
          return { body: sessionPage(sessions, sessions.length) };
        return baseRoutes(url, init);
      });

      const { store } = await initStore();
      await vi.waitFor(() =>
        expect(store.getState()).toMatchObject({
          sessions,
          sessionListLoading: false,
          sessionListHydrating: false,
        }),
      );
      const refreshing = store.refreshSession();
      await vi.waitFor(() => expect(reads).toBe(1));
      const removing =
        method === "clear"
          ? store.clearHiddenSessions(targets)
          : store.deleteSession("s1");
      await requested.promise;
      await store.refreshSession();
      expect(reads).toBe(1);

      const rejectOldRead = () =>
        oldRead.resolve(
          result === "unauthorized"
            ? { status: 401, body: { error: "Pairing expired" } }
            : { status: 409, body: { error: "That session is being deleted" } },
        );
      if (result === "unauthorized") {
        rejectOldRead();
        await refreshing;
        expect(store.getState()).toMatchObject({
          needsToken: true,
          connection: "offline",
        });
        deletion.resolve();
        await removing;
        expect(store.getState().live.notices).toEqual([]);
        return;
      }
      if (result !== "committed") {
        rejectOldRead();
        await refreshing;
        expect(store.getState().error).toBeNull();
      }
      deletion.resolve();
      await removing;
      if (result === "committed") {
        rejectOldRead();
        await refreshing;
        expect(store.getState()).toMatchObject({
          sessionId: null,
          error: null,
        });
        expect(
          store
            .getState()
            .live.notices.every((notice) => notice.kind === "info"),
        ).toBe(true);
      } else {
        await vi.waitFor(() => expect(reads).toBe(2));
        expect(store.getState()).toMatchObject({
          sessionId: "s1",
          error: null,
          sessionDeleteError: expect.stringContaining("Trash unavailable"),
        });
      }
    },
  );

  it("waits for confirmed Hide and reconciles deletion while preserving newer preferences and the other draft", async () => {
    const active = activeSnapshot({ sessionId: "s1" });
    active.sessionStatuses.s2 = { runState: "idle", indicator: "completed" };
    const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
    const initial = {
      ...DEFAULT_PREFS,
      pinnedSessionIds: ["s2"],
      hiddenSessionIds: [],
    };
    const hide = deferred<void>();
    const deletion = deferred<void>();
    const requested = deferred<void>();
    const patches: Record<string, unknown>[] = [];
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            startupSessionId: "s1",
            preferences: initial,
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        if ("hiddenSessionIds" in patch) await hide.promise;
        Object.assign(initial, patch);
        return { body: { ...initial } };
      }
      if (url === "/api/sessions/delete") {
        requested.resolve();
        await deletion.promise;
        deleted = true;
        return { body: committed("s2", { ...DEFAULT_PREFS, theme: "dark" }) };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: deleted ? [] : [rows[1]] } };
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return { body: sessionPage(sessions, sessions.length) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore(active);
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));
    store.drafts.setText("s1", "keep this draft");
    store.drafts.setText("s2", "deleted draft");

    store.toggleSessionHidden("s2");
    await vi.waitFor(() =>
      expect(patches).toEqual([
        { hiddenSessionIds: ["s2"], pinnedSessionIds: [] },
      ]),
    );
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
    await expect(store.deleteSession("s2")).resolves.toBeNull();
    hide.resolve();
    await vi.waitFor(() =>
      expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]),
    );
    const removing = store.deleteSession("s2");
    await requested.promise;
    store.setPreference("theme", "dark");
    store.toggleSessionPin("s1");
    await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
    expect(patches).toEqual([
      { hiddenSessionIds: ["s2"], pinnedSessionIds: [] },
      { theme: "dark" },
    ]);
    deletion.resolve();
    await removing;
    expect(store.getState().sessions.map(({ id }) => id)).toEqual(["s1"]);
    expect(store.getState().sessionStatuses).not.toHaveProperty("s2");
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      pinnedSessionIds: [],
      hiddenSessionIds: [],
    });
    expect(store.drafts.get("s1").text).toBe("keep this draft");
    expect(store.drafts.get("s2").text).toBe("");
  });
});
