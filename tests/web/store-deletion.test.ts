// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
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

  it("removes a deleted hidden session from curation, pagination, status, and its draft", async () => {
    const active = activeSnapshot({ sessionId: "s1", sessionName: "Active" });
    active.sessionStatuses.s2 = { runState: "idle", indicator: "completed" };
    const rows = [
      sessionSummary({ id: "s1", title: "Active" }),
      sessionSummary({ id: "s2", title: "Archived" }),
    ];
    let deleted = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: active,
            preferences: {
              ...DEFAULT_PREFS,
              pinnedSessionIds: ["s2"],
              hiddenSessionIds: ["s2"],
            },
          }),
        };
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleted = true;
        return {
          body: {
            sessionId: "s2",
            disposition: "trashed",
            preferences: {
              ...DEFAULT_PREFS,
              pinnedSessionIds: [],
              hiddenSessionIds: [],
            },
          },
        };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: deleted ? [] : [rows[1]] } };
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? rows.slice(0, 1) : rows;
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() =>
      expect(store.getState().sessions.map((session) => session.id)).toEqual([
        "s1",
        "s2",
      ]),
    );
    setSessionDraft("s2", "not for another session");

    await expect(store.deleteSession("s2")).resolves.toBe("trashed");
    expect(store.getState().sessions.map((session) => session.id)).toEqual([
      "s1",
    ]);
    expect(store.getState().sessionStatuses).not.toHaveProperty("s2");
    expect(store.getState().prefs).toMatchObject({
      pinnedSessionIds: [],
      hiddenSessionIds: [],
    });
    expect(sessionDraft("s2")).toBe("");
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Session moved to Trash",
    );
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
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
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

  it("preserves a newer setting when deletion returns an older preference snapshot", async () => {
    const rows = [sessionSummary({ id: "s1" }), sessionSummary({ id: "s2" })];
    const { promise: deleteGate, resolve: releaseDelete } = deferred<void>();
    const { promise: started, resolve: deleteStarted } = deferred<void>();
    const patches: Record<string, unknown>[] = [];
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        return { body: { ...DEFAULT_PREFS, ...patch } };
      }
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        deleteStarted();
        await deleteGate;
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
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(2));

    const deleting = store.deleteSession("s2");
    await started;
    store.setTheme("dark");
    store.toggleSessionPin("s1");
    expect(store.getState().prefs.pinnedSessionIds).toEqual([]);
    await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
    expect(patches.some((patch) => "pinnedSessionIds" in patch)).toBe(false);
    releaseDelete();

    await expect(deleting).resolves.toBe("trashed");
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      hiddenSessionIds: [],
    });
  });

  it("preserves a newer setting when clearing Hidden returns an older preference snapshot", async () => {
    const row = sessionSummary({ id: "s2" });
    const { promise: clearGate, resolve: releaseClear } = deferred<void>();
    const { promise: started, resolve: clearStarted } = deferred<void>();
    const patches: Record<string, unknown>[] = [];
    let deleted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        return { body: { ...DEFAULT_PREFS, ...patch } };
      }
      if (url.startsWith("/api/sessions/clear-hidden")) {
        clearStarted();
        await clearGate;
        deleted = true;
        return {
          body: {
            deleted: [{ sessionId: "s2", disposition: "trashed" }],
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: [] },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const sessions = deleted ? [] : [row];
        return {
          body: { sessions, total: sessions.length, offset: 0, limit: 40 },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(1));

    const clearing = store.clearHiddenSessions(["s2"]);
    await started;
    store.setTheme("dark");
    await vi.waitFor(() => expect(patches).toContainEqual({ theme: "dark" }));
    releaseClear();

    await expect(clearing).resolves.toMatchObject({
      deleted: [{ sessionId: "s2", disposition: "trashed" }],
    });
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      hiddenSessionIds: [],
    });
  });

  it("keeps local session state intact when deletion is refused", async () => {
    const row = sessionSummary({ id: "s2", title: "Archived" });
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: { ...DEFAULT_PREFS, hiddenSessionIds: ["s2"] },
          }),
        };
      if (url.startsWith("/api/sessions/s2") && init.method === "DELETE") {
        return { status: 409, body: { error: "Session is still running" } };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [row] } };
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [row], total: 1, offset: 0, limit: 40 } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(store.getState().sessions).toHaveLength(1));
    setSessionDraft("s2", "keep me");

    await expect(store.deleteSession("s2")).resolves.toBeNull();
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["s2"]);
    expect(sessionDraft("s2")).toBe("keep me");
    expect(store.getState().error).toBeNull();
    expect(store.getState().sessionDeleteError).toBe(
      "Session is still running",
    );
  });
});
