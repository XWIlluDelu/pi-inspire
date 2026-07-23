// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTheme } from "../../src/App";
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

describe("resolveTheme", () => {
  it("resolves the system preference against the media query", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("passes explicit preferences through", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("preference persistence", () => {
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    saved = [];
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload() };
      if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      if (url.startsWith("/api/preferences") && init.method === "PUT") {
        saved.push(jsonBody(init));
        return { body: jsonBody(init) };
      }
      return undefined;
    });
  });

  it("setTheme updates local state and persists via PUT /api/preferences", async () => {
    const store = new AppStore();
    await store.init("token");
    store.setTheme("dark");
    expect(store.getState().prefs.theme).toBe("dark");
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(saved.at(-1)).toMatchObject({ theme: "dark" });
  });

  it("setLaunch switches the launch behavior preference", async () => {
    const store = new AppStore();
    await store.init("token");
    store.setLaunch("continue");
    expect(store.getState().prefs.launch).toBe("continue");
    await vi.waitFor(() => expect(saved.some((body) => body.launch === "continue")).toBe(true));
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
        return { body: bootstrapPayload({ preferences: { ...DEFAULT_PREFS, launch: "continue" } }) };
      }
      if (url.startsWith("/api/sessions/open")) return { body: activeSnapshot({ sessionId: summary.id }) };
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [summary], total: 1, offset: 0, limit: 40 } };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await vi.waitFor(() => expect(store.getState().sessionId).toBe(summary.id));
  });

  it("welcome: stays on the welcome page even with recent sessions", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return { body: bootstrapPayload({ preferences: { ...DEFAULT_PREFS, launch: "welcome" } }) };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [sessionSummary()], total: 1, offset: 0, limit: 40 } };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getState().sessionId).toBeNull();
  });
});
