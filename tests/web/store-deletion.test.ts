// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
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
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("session deletion ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it.each(["success", "failure", "newer-selection", "opening"] as const)(
    "deletes the visible session with %s ownership",
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
              snapshot: activeSnapshot({ sessionId: "s1" }),
              preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s1"] },
            }),
          };
        if (url === "/api/sessions/s1" && init.method === "DELETE") {
          requested = true;
          await deleteGate;
          if (outcome === "failure")
            return { status: 500, body: { error: "Trash unavailable" } };
          deleted = true;
          return {
            body: {
              sessionId: "s1",
              disposition: "trashed",
              preferences: DEFAULT_PREFS,
            },
          };
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
      setSessionDraft("s1", "deleted draft");
      setSessionDraft("s2", "keep this draft");
      const deleting = store.deleteSession("s1");
      await vi.waitFor(() => expect(requested).toBe(true));
      expect(store.getState().sessionId).toBe("s1");
      let opening: Promise<void> | undefined;
      if (outcome === "newer-selection" || outcome === "opening") {
        opening = store.openSession("s2");
        if (outcome === "newer-selection") await opening;
      }
      releaseDelete();
      await expect(deleting).resolves.toBe(
        outcome === "failure" ? null : "trashed",
      );
      if (outcome === "opening") {
        expect(store.getState().sessionSelectionPending).toBe(true);
        releaseOpen();
        await opening;
      }
      expect(store.getState().sessionId).toBe(
        outcome === "failure" ? "s1" : outcome === "success" ? null : "s2",
      );
      if (outcome === "failure") {
        expect(sessionDraft("s1")).toBe("deleted draft");
        expect(store.getState().prefs.hiddenSessionIds).toEqual(["s1"]);
        expect(store.getState().sessions).toHaveLength(2);
        expect(store.getState().sessionDeleteError).toBe("Trash unavailable");
      } else {
        expect(sessionDraft("s1")).toBe("");
        expect(store.getState().sessionStatuses.s1).toBeUndefined();
        expect(store.getState().externalSessionActivities.s1).toBeUndefined();
      }
      expect(sessionDraft("s2")).toBe("keep this draft");
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes("/deselect")),
      ).toBe(false);
    },
  );

  it.each([
    { method: "delete", result: "committed" },
    { method: "clear", result: "committed" },
    { method: "delete", result: "refused" },
    { method: "clear", result: "partial" },
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
              snapshot: activeSnapshot(),
              preferences: { ...DEFAULT_PREFS, hiddenSessionIds: targets },
            }),
          };
        if (url.startsWith("/api/snapshot")) {
          reads += 1;
          return reads === 1 ? oldRead.promise : { body: activeSnapshot() };
        }
        if (
          (url === "/api/sessions/s1" && init.method === "DELETE") ||
          url === "/api/sessions/clear-hidden"
        ) {
          requested.resolve();
          await deletion.promise;
          if (result === "refused")
            return { status: 500, body: { error: "Trash unavailable" } };
          const sessionId = result === "partial" ? "s2" : "s1";
          sessions = sessions.filter((row) => row.id !== sessionId);
          const deleted = { sessionId, disposition: "trashed" };
          if (result === "partial")
            return {
              body: {
                deleted: [deleted],
                failure: { sessionId: "s1", message: "Trash unavailable" },
              },
            };
          return {
            body: method === "clear" ? { deleted: [deleted] } : deleted,
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
        oldRead.resolve({
          status: 409,
          body: { error: "That session is being deleted" },
        });
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
          store.getState().notices.every((notice) => notice.kind === "info"),
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

  it("keeps authentication failures transport-wide during deletion", async () => {
    const response = deferred<{ status: number; body: { error: string } }>();
    const deletion = deferred<void>();
    let deleting = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s1"] },
          }),
        };
      if (url.startsWith("/api/snapshot")) return response.promise;
      if (url === "/api/sessions/s1" && init.method === "DELETE") {
        deleting = true;
        await deletion.promise;
        return { body: { sessionId: "s1", disposition: "trashed" } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const refreshing = store.refreshSession();
    const removing = store.deleteSession("s1");
    await vi.waitFor(() => expect(deleting).toBe(true));
    response.resolve({ status: 401, body: { error: "Pairing expired" } });
    await refreshing;
    expect(store.getState()).toMatchObject({
      needsToken: true,
      connection: "offline",
    });
    deletion.resolve();
    await removing;
    expect(store.getState().notices).toEqual([]);
  });

  it("fences an optimistic Hide write before sending the destructive request", async () => {
    const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
    const { promise: patchGate, resolve: releasePatch } = deferred<void>();
    let deleteCalled = false;
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        await patchGate;
        return { body: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] } };
      }
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleteCalled = true;
        deleted = true;
        return {
          body: {
            sessionId: "s2",
            disposition: "trashed",
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: [] },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return {
          body: sessionPage(sessions, sessions.length),
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));

    store.toggleSessionHidden("s2");
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]);
    const deleting = store.deleteSession("s2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteCalled).toBe(false);
    releasePatch();
    await expect(deleting).resolves.toBe("trashed");
    expect(deleteCalled).toBe(true);
  });

  it.each(["delete", "clear"] as const)(
    "reconciles %s without discarding a newer setting or the other session's draft",
    async (method) => {
      const active = activeSnapshot({ sessionId: "s1" });
      active.sessionStatuses.s2 = { runState: "idle", indicator: "completed" };
      const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
      const initial = {
        ...DEFAULT_PREFS,
        pinnedSessionIds: ["s2"],
        hiddenSessionIds: ["s2"],
      };
      const deletion = deferred<void>();
      const requested = deferred<void>();
      const patches: Record<string, unknown>[] = [];
      let deleted = false;
      installFetch(async (url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return {
            body: bootstrapPayload({ snapshot: active, preferences: initial }),
          };
        if (url.startsWith("/api/preferences") && init.method === "PATCH") {
          const patch = jsonBody(init);
          patches.push(patch);
          return { body: { ...initial, ...patch } };
        }
        if (
          (url === "/api/sessions/s2" && init.method === "DELETE") ||
          url === "/api/sessions/clear-hidden"
        ) {
          requested.resolve();
          await deletion.promise;
          deleted = true;
          const outcome = { sessionId: "s2", disposition: "trashed" };
          return {
            body: {
              ...(method === "clear" ? { deleted: [outcome] } : outcome),
              preferences: DEFAULT_PREFS,
            },
          };
        }
        if (url.startsWith("/api/sessions/by-id"))
          return { body: { sessions: deleted ? [] : [rows[1]] } };
        if (url.startsWith("/api/sessions")) {
          const sessions = deleted ? rows.slice(0, 1) : rows;
          return { body: sessionPage(sessions, sessions.length) };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));
      setSessionDraft("s1", "keep this draft");
      setSessionDraft("s2", "deleted draft");

      const removing =
        method === "clear"
          ? store.clearHiddenSessions(["s2"])
          : store.deleteSession("s2");
      await requested.promise;
      store.setTheme("dark");
      store.toggleSessionPin("s1");
      await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
      expect(patches.some((patch) => "pinnedSessionIds" in patch)).toBe(false);
      deletion.resolve();
      await removing;
      expect(store.getState().sessions.map(({ id }) => id)).toEqual(["s1"]);
      expect(store.getState().sessionStatuses).not.toHaveProperty("s2");
      expect(store.getState().prefs).toMatchObject({
        theme: "dark",
        pinnedSessionIds: [],
        hiddenSessionIds: [],
      });
      expect(sessionDraft("s1")).toBe("keep this draft");
      expect(sessionDraft("s2")).toBe("");
    },
  );
});
