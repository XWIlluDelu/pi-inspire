import { beforeEach, expect, it, vi } from "vitest";
import type { AppStore } from "../../src/store";
import { installCatalog, sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  selectSession,
  sessionSummary,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

const recent = sessionSummary({ id: "recent", cwd: "/work/other" });
const offPage = sessionSummary({ id: "off-page", cwd: "/work/demo" });
const ids = (store: AppStore) => store.getState().sessions.map(({ id }) => id);
const summary = (names: (typeof recent)[], total = names.length) => ({
  body: sessionPage(names, total),
});
const prefs = (patch: Partial<typeof DEFAULT_PREFS>) => ({
  ...DEFAULT_PREFS,
  ...patch,
});
const nextHost = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => installFakeWebSocket());

it.each([404, 409] as const)(
  "keeps the prior selection after a %i refusal and repairs only a missing catalog row",
  async (status) => {
    const current = sessionSummary({ id: "s1" });
    const target = sessionSummary({ id: "s9" });
    const error =
      status === 404
        ? "Session not found"
        : "Session is owned by another Pi process";
    let removed = false;
    installStoreRoutes((url, init) => {
      if (url.startsWith("/api/sessions?"))
        return summary(removed ? [current] : [current, target]);
      if (url !== "/api/sessions/open") return;
      if (jsonBody(init).id === "s3")
        return { body: activeSnapshot({ sessionId: "s3" }) };
      removed = status === 404;
      return {
        status,
        body: { error, ...(removed ? { code: "SESSION_NOT_FOUND" } : {}) },
      };
    });
    const { store } = await initStore();
    await vi.waitFor(() => expect(ids(store)).toEqual(["s1", "s9"]));
    await store.openSession("s9");
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      sessionSelectionPending: false,
      error: null,
      sessionActionError: error,
    });
    await vi.waitFor(() =>
      expect(ids(store)).toEqual(removed ? ["s1"] : ["s1", "s9"]),
    );
    await store.openSession("s3");
    expect(store.getState()).toMatchObject({
      sessionId: "s3",
      sessionActionError: null,
    });
  },
);

it("hydrates confirmed folder curation without rereading pages and prunes it before a stale hydration returns", async () => {
  const write = deferred<void>();
  const stale = deferred<void>();
  const catalog = vi.fn(() => summary([recent], 8));
  const lookup = vi
    .fn<() => RouteResponse | Promise<RouteResponse>>()
    .mockReturnValue(summary([offPage]));
  const { store } = await installCatalog(catalog, {
    routes: async (url, init) => {
      if (url === "/api/preferences") {
        await write.promise;
        return { body: jsonBody(init) };
      }
      if (url === "/api/sessions/by-cwd") return lookup();
      if (url === "/api/sessions/refresh") return { body: { ok: true } };
    },
  });
  await vi.waitFor(() => expect(ids(store)).toEqual([recent.id]));
  store.toggleProjectHidden(offPage.cwd);
  expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);
  write.resolve();
  await vi.waitFor(() => expect(ids(store)).toEqual([recent.id, offPage.id]));
  expect(catalog).toHaveBeenCalledOnce();
  expect(store.getState()).toMatchObject({
    prefs: { hiddenProjectCwds: [offPage.cwd] },
    sessionListNextOffset: 1,
    sessionListTotal: 8,
  });

  lookup.mockReturnValueOnce(stale.promise.then(() => summary([offPage])));
  const refreshed = store.refreshSessions();
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  store.toggleProjectHidden(offPage.cwd);
  await vi.waitFor(() => expect(ids(store)).toEqual([recent.id]));
  stale.resolve();
  await refreshed;
  expect(ids(store)).toEqual([recent.id]);
  expect(catalog).toHaveBeenCalledTimes(2);
});

it.each(["rejected", "confirmed"] as const)(
  "keeps an off-page row until its restore write is %s",
  async (outcome) => {
    const write = deferred<RouteResponse>();
    const catalog = vi.fn(() => summary([recent], 2));
    const { store } = await installCatalog(catalog, {
      preferences: { hiddenSessionIds: [offPage.id] },
      routes: (url) => {
        if (url === "/api/preferences") return write.promise;
        if (url === "/api/sessions/by-id") return summary([offPage]);
      },
    });
    await vi.waitFor(() => expect(ids(store)).toEqual([recent.id, offPage.id]));
    store.toggleSessionHidden(offPage.id);
    expect(store.getState()).toMatchObject({
      curationPending: true,
      prefs: { hiddenSessionIds: [offPage.id] },
    });
    write.resolve(
      outcome === "confirmed"
        ? { body: prefs({ hiddenSessionIds: [] }) }
        : { status: 409, body: { error: "Preference write rejected" } },
    );
    await vi.waitFor(() =>
      expect(store.getState().curationPending).toBe(false),
    );
    expect(ids(store)).toEqual(
      outcome === "confirmed" ? [recent.id] : [recent.id, offPage.id],
    );
    if (outcome === "rejected")
      expect(store.getState().live.notices.at(-1)?.text).toBe(
        "Preference write rejected",
      );
    expect(catalog).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      sessionListNextOffset: 1,
      sessionListTotal: 2,
    });
  },
);

it("retries a child restore once the hidden folder's membership can be read", async () => {
  const child = sessionSummary({
    id: "child",
    cwd: offPage.cwd,
    title: "Restore me",
  });
  const sibling = sessionSummary({ id: "sibling", cwd: offPage.cwd });
  const folder = vi
    .fn<() => RouteResponse>()
    .mockReturnValue(summary([child, sibling]));
  const { store } = await installCatalog(() => summary([child]), {
    preferences: { hiddenProjectCwds: [offPage.cwd] },
    routes: (url) => (url === "/api/sessions/by-cwd" ? folder() : undefined),
  });
  await store.loadSessions(child.title);
  folder.mockReturnValueOnce({
    status: 503,
    body: { error: "Folder lookup failed" },
  });
  store.toggleSessionHidden(child.id);
  await vi.waitFor(() =>
    expect(store.getState().live.notices.at(-1)?.text).toBe(
      "Folder lookup failed",
    ),
  );
  expect(store.getState().prefs).toMatchObject({
    hiddenProjectCwds: [offPage.cwd],
    hiddenSessionIds: [],
  });
  store.toggleSessionHidden(child.id);
  await vi.waitFor(() =>
    expect(store.getState().prefs).toMatchObject({
      hiddenProjectCwds: [],
      hiddenSessionIds: [sibling.id],
    }),
  );
});

it.each([false, true])(
  "keeps preference publication bound to its Host across reconnect (replacement: %s)",
  async (replacement) => {
    const write = deferred<void>();
    const pending = deferred<void>();
    const save = vi.fn();
    let reconnected = false;
    let theme: typeof DEFAULT_PREFS.theme = "system";
    installStoreRoutes(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload(
            reconnected && replacement
              ? {
                  authorityId: nextHost,
                  preferences: prefs({ theme: "light" }),
                  preferenceRevision: 1,
                }
              : { startupSessionId: "s1", preferences: prefs({ theme }) },
          ),
        };
      if (url !== "/api/preferences") return;
      if (init.method === "PATCH") {
        save(jsonBody(init));
        pending.resolve();
        await write.promise;
        theme = "dark";
      }
      return {
        body: {
          preferences: prefs({ theme }),
          revision: theme === "dark" ? 500 : 2,
        },
      };
    });
    const { store } = await initStore();
    store.setPreference("theme", "dark");
    await pending.promise;
    reconnected = true;
    await store.init();
    expect(store.getState().prefs.theme).toBe(replacement ? "light" : "system");
    expect(store.getState().desiredPreferences).toEqual({});
    write.resolve();
    if (replacement) {
      // Flush the old write continuation while the new authority stays selected.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getState().prefs.theme).toBe("light");
    } else
      await vi.waitFor(() => expect(store.getState().prefs.theme).toBe("dark"));
    expect(save).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
  },
);

it("applies a late rename only to the session it targeted", async () => {
  const rename = deferred<RouteResponse>();
  const request = vi.fn((_body: Record<string, unknown>) => rename.promise);
  installStoreRoutes((url, init) =>
    url === "/api/sessions/rename" ? request(jsonBody(init)) : undefined,
  );
  const { store } = await initStore();
  const writing = store.renameSession("s1", "Renamed A");
  await selectSession(
    store,
    activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
  );
  rename.resolve({ body: { ok: true } });
  await expect(writing).resolves.toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    sessionId: "s1",
    name: "Renamed A",
  });
  expect(store.getState().sessionName).toBe("Session B");
});
