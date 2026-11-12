// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInterfaceSettings } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  DEFAULT_PREFS,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

describe("preference persistence", () => {
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    saved = [];
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        saved.push(jsonBody(init));
        return { body: jsonBody(init) };
      }
      return undefined;
    });
  });

  it("surfaces a host preference-validation warning after bootstrap", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferencesWarning:
              "Saved preferences are invalid. The saved file was left unchanged.",
          }),
        };
      }
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
    const store = new AppStore();
    await store.init();
    expect(store.getState().notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          text: expect.stringMatching(/left unchanged/),
        }),
      ]),
    );
  });

  it("queues rapid changes in order, each patch carrying only its own field", async () => {
    const store = new AppStore();
    await store.init();
    const order = [
      "copy-id",
      "export",
      "rename",
      "clone",
      "switch-branch",
    ] as const;
    store.setTheme("dark");
    store.setSessionActionOrder([...order]);
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      sessionActionOrder: order,
    });
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved).toEqual([{ theme: "dark" }, { sessionActionOrder: order }]);
  });
});

describe("settings reset", () => {
  beforeEach(() => installFakeWebSocket());

  it("restores only user-facing Settings fields", async () => {
    const patches: Record<string, unknown>[] = [];
    const initial = {
      ...bootstrapPayload().preferences,
      theme: "dark" as const,
      palette: "hydrangea" as const,
      titlebarNeedles: true,
      contentTextSize: "large" as const,
      readingWidth: "wide" as const,
      launch: "continue" as const,
      desktopSendKey: "mod-enter" as const,
      thinkingVisibility: "hidden" as const,
      toolVisibility: "hidden" as const,
      activityFoldVisibility: "expanded" as const,
      projectDisplay: "path" as const,
      recentModelIds: [{ provider: "provider", id: "model" }],
      navCollapsedGroups: ["/kept"],
    };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            preferences: initial,
            snapshot: activeSnapshot(),
          }),
        };
      if (url.startsWith("/api/preferences") && init.method === "PATCH") {
        const patch = jsonBody(init);
        patches.push(patch);
        return { body: { ...initial, ...patch } };
      }
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
    const appStore = new AppStore();
    await appStore.init();

    appStore.restoreDefaultSettings();
    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual(defaultInterfaceSettings);
    expect(appStore.getState().taskAlerts.mode).toBe("off");
    expect(appStore.getState().prefs).toMatchObject({
      ...defaultInterfaceSettings,
      recentModelIds: [{ provider: "provider", id: "model" }],
      navCollapsedGroups: ["/kept"],
    });
  });
});

describe("launch behavior", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  it("continue: automatically opens the most recent session once", async () => {
    const summary = sessionSummary();
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "continue" },
          }),
        };
      }
      if (url.startsWith("/api/sessions/open"))
        return { body: activeSnapshot({ sessionId: summary.id }) };
      if (url.startsWith("/api/sessions")) {
        return {
          body: sessionPage([summary], 1),
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init();
    await vi.waitFor(() => expect(store.getState().sessionId).toBe(summary.id));
  });

  it("does not auto-continue over a new-session intent while the catalog is loading", async () => {
    const previous = sessionSummary({ id: "previous" });
    let releaseCatalog!: () => void;
    let releaseCreate!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let openCalls = 0;
    installFetch(async (url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "continue" },
          }),
        };
      }
      if (url.startsWith("/api/sessions/new")) {
        await createGate;
        return { body: activeSnapshot({ sessionId: "created" }) };
      }
      if (url.startsWith("/api/sessions/open")) {
        openCalls += 1;
        return { body: activeSnapshot({ sessionId: previous.id }) };
      }
      if (url.startsWith("/api/sessions")) {
        await catalogGate;
        return {
          body: sessionPage([previous], 1),
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init();
    const creating = store.newSession("/work/new");
    expect(store.getState().sessionSelectionPending).toBe(true);

    releaseCatalog();
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({
        sessions: [previous],
        sessionListLoading: false,
      }),
    );
    expect(openCalls).toBe(0);
    expect(store.getState().sessionId).toBeNull();

    releaseCreate();
    await expect(creating).resolves.toBe("created");
    expect(store.getState().sessionId).toBe("created");
  });

  it("welcome: stays on the welcome page even with recent sessions", async () => {
    const recent = sessionSummary();
    const open = vi.fn(() => ({
      body: activeSnapshot({ sessionId: recent.id }),
    }));
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "welcome" },
          }),
        };
      }
      if (url.startsWith("/api/sessions/open")) return open();
      if (url.startsWith("/api/sessions")) {
        return {
          body: sessionPage([recent], 1),
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init();
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({
        sessions: [recent],
        sessionListLoading: false,
      }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(store.getState().sessionId).toBeNull();
  });
});
