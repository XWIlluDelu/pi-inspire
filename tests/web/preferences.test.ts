// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInterfaceSettings } from "../../shared/contracts";
import { AppStore } from "../../src/store";
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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    expect(store.getState().notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          text: expect.stringMatching(/left unchanged/),
        }),
      ]),
    );
  });

  it("setTheme updates local state and persists a field-scoped PATCH", async () => {
    const store = new AppStore();
    await store.init("token");
    store.setTheme("dark");
    expect(store.getState().prefs.theme).toBe("dark");
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(saved.at(-1)).toEqual({ theme: "dark" });
  });

  it("queues rapid changes in order, each patch carrying only its own field", async () => {
    const store = new AppStore();
    await store.init("token");
    store.setTheme("dark");
    store.setToolVisibility("hidden");
    expect(store.getState().prefs).toMatchObject({
      theme: "dark",
      toolVisibility: "hidden",
    });
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved).toEqual([{ theme: "dark" }, { toolVisibility: "hidden" }]);
  });
});

describe("settings reset", () => {
  beforeEach(() => installFakeWebSocket());

  it("restores only user-facing Settings fields", async () => {
    const patches: Record<string, unknown>[] = [];
    const initial = {
      ...bootstrapPayload().preferences,
      theme: "dark" as const,
      palette: "teal" as const,
      contentTextSize: "large" as const,
      readingWidth: "wide" as const,
      launch: "continue" as const,
      desktopSendKey: "mod-enter" as const,
      thinkingVisibility: "hidden" as const,
      toolVisibility: "hidden" as const,
      activityFoldVisibility: "expanded" as const,
      assistantRoundDisplay: "details" as const,
      projectDisplay: "path" as const,
      completionAttention: "title" as const,
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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      return undefined;
    });
    const appStore = new AppStore();
    await appStore.init("token");

    appStore.restoreDefaultSettings();
    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual(defaultInterfaceSettings);
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
          body: { sessions: [summary], total: 1, offset: 0, limit: 40 },
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
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
          body: { sessions: [previous], total: 1, offset: 0, limit: 40 },
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const creating = store.newSession("/work/new");
    expect(store.getState().sessionSelectionPending).toBe(true);

    releaseCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openCalls).toBe(0);
    expect(store.getState().sessionId).toBeNull();

    releaseCreate();
    await expect(creating).resolves.toBe("created");
    expect(store.getState().sessionId).toBe("created");
  });

  it("welcome: stays on the welcome page even with recent sessions", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            preferences: { ...DEFAULT_PREFS, launch: "welcome" },
          }),
        };
      }
      if (url.startsWith("/api/sessions")) {
        return {
          body: {
            sessions: [sessionSummary()],
            total: 1,
            offset: 0,
            limit: 40,
          },
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getState().sessionId).toBeNull();
  });
});
