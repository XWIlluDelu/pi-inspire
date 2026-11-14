// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { defaultInterfaceSettings } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  sessionSummary,
} from "./helpers";
import { installStoreRoutes } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

it("publishes ordered field changes and retires only the refused intent through A–B–A and Reset", async () => {
  const first = deferred<RouteResponse>();
  const second = deferred<RouteResponse>();
  const last = deferred<RouteResponse>();
  const actionOrder = deferred<RouteResponse>();
  const kept = {
    recentModelIds: [{ provider: "provider", id: "model" }],
    navCollapsedGroups: ["/kept"],
  };
  const initial = { ...DEFAULT_PREFS, ...kept, titlebarNeedles: true };
  const order = [
    "copy-id",
    "export",
    "rename",
    "clone",
    "switch-branch",
  ] as const;
  const stored = {
    ...initial,
    theme: "dark" as const,
    sessionActionOrder: [...order],
  };
  const saves = vi
    .fn<
      (
        _patch: Record<string, unknown>,
      ) => RouteResponse | Promise<RouteResponse>
    >()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(last.promise)
    .mockReturnValueOnce(actionOrder.promise)
    .mockReturnValueOnce({
      body: {
        preferences: { ...stored, ...defaultInterfaceSettings },
        revision: 5,
      },
    });
  const notice =
    "Tool visibility is invalid. The saved file was left unchanged.";
  installStoreRoutes((url, init) => {
    if (url === "/api/preferences" && init.method === "PATCH")
      return saves(jsonBody(init));
    if (url === "/api/bootstrap")
      return {
        body: bootstrapPayload({
          preferences: initial,
          preferenceRevision: 1,
          preferencesWarning: notice,
        }),
      };
  });
  const store = new AppStore();
  await store.init();
  expect(store.getState().live.notices).toContainEqual(
    expect.objectContaining({ kind: "warning", text: notice }),
  );

  for (const theme of ["dark", "light", "dark"] as const)
    store.setPreference("theme", theme);
  store.setPreference("sessionActionOrder", [...order]);
  await vi.waitFor(() =>
    expect(saves).toHaveBeenCalledExactlyOnceWith({ theme: "dark" }),
  );
  first.resolve({ status: 409, body: { error: "Preference refused" } });
  await vi.waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
  expect(store.getState()).toMatchObject({
    prefs: { theme: "system" },
    desiredPreferences: { theme: "dark", sessionActionOrder: order },
  });

  second.resolve({
    body: { preferences: { ...initial, theme: "light" }, revision: 2 },
  });
  await vi.waitFor(() => expect(saves).toHaveBeenCalledTimes(3));
  expect(store.getState()).toMatchObject({
    prefs: { theme: "light" },
    desiredPreferences: { theme: "dark" },
  });
  last.resolve({
    body: { preferences: { ...initial, theme: "dark" }, revision: 3 },
  });
  await vi.waitFor(() => expect(saves).toHaveBeenCalledTimes(4));
  expect(store.getState()).toMatchObject({
    prefs: { theme: "dark" },
    desiredPreferences: { sessionActionOrder: order },
  });
  actionOrder.resolve({
    body: { preferences: { ...stored, theme: "light" }, revision: 2 },
  });
  await vi.waitFor(() =>
    expect(store.getState().desiredPreferences).toEqual({}),
  );
  expect(saves.mock.calls).toEqual([
    [{ theme: "dark" }],
    [{ theme: "light" }],
    [{ theme: "dark" }],
    [{ sessionActionOrder: order }],
  ]);
  expect(store.getState().prefs).toEqual({ ...initial, theme: "dark" });

  store.restoreDefaultSettings();
  await vi.waitFor(() =>
    expect(store.getState().desiredPreferences).toEqual({}),
  );
  expect(saves).toHaveBeenLastCalledWith(defaultInterfaceSettings);
  expect(store.getState().prefs).toEqual({
    ...stored,
    ...defaultInterfaceSettings,
    ...kept,
  });
});

it("keeps an unsuccessfully hidden session outside destructive review", async () => {
  const previous = sessionSummary({ id: "kept" });
  const save = deferred<RouteResponse>();
  const remove = vi.fn();
  installStoreRoutes((url) => {
    if (url === "/api/bootstrap") return { body: bootstrapPayload() };
    if (url === "/api/preferences") return save.promise;
    if (url === "/api/sessions/delete") return remove();
    if (url.startsWith("/api/sessions?"))
      return { body: sessionPage([previous], 1) };
  });
  const store = new AppStore();
  await store.init();
  await vi.waitFor(() => expect(store.getState().sessions).toEqual([previous]));

  store.toggleSessionHidden(previous.id);
  expect(store.getState()).toMatchObject({
    curationPending: true,
    prefs: { hiddenSessionIds: [] },
  });
  await expect(store.deleteSession(previous.id)).resolves.toBeNull();
  save.resolve({ status: 409, body: { error: "Hide refused" } });
  await vi.waitFor(() => expect(store.getState().curationPending).toBe(false));
  expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  await expect(store.deleteSession(previous.id)).resolves.toBeNull();
  await expect(store.clearHiddenSessions([previous.id])).resolves.toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it.each(["welcome", "continued", "new-intent"] as const)(
  "honors %s after an addressed Welcome snapshot and a delayed catalog",
  async (caseName) => {
    const previous = sessionSummary({ id: "previous" });
    const catalog = deferred<void>();
    const create = deferred<void>();
    const open = vi.fn(() => ({
      body: activeSnapshot({ sessionId: previous.id }),
    }));
    installStoreRoutes(async (url) => {
      if (url === "/api/bootstrap")
        return {
          body: bootstrapPayload({
            preferences: {
              ...DEFAULT_PREFS,
              launch: caseName === "welcome" ? "welcome" : "continue",
            },
          }),
        };
      if (url === "/api/sessions/open") return open();
      if (url === "/api/sessions/new") {
        await create.promise;
        return { body: activeSnapshot({ sessionId: "created" }) };
      }
      if (url.startsWith("/api/sessions?")) {
        await catalog.promise;
        return { body: sessionPage([previous], 1) };
      }
    });

    const store = new AppStore();
    await store.init();
    FakeWebSocket.instances.at(-1)!.join();
    const creating =
      caseName === "new-intent" ? store.newSession("/work/new") : undefined;
    catalog.resolve();
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({
        sessions: [previous],
        startupPending: false,
        sessionListLoading: false,
        sessionId: caseName === "continued" ? previous.id : null,
      }),
    );
    if (caseName === "continued") expect(open).toHaveBeenCalledOnce();
    else expect(open).not.toHaveBeenCalled();
    create.resolve();
    if (creating) await expect(creating).resolves.toBe("created");
  },
);
