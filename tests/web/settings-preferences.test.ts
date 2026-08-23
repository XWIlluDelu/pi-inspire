// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInterfaceSettings } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

describe("Settings preference ownership", () => {
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
