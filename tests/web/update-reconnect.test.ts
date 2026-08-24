// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

function installLocalStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

describe("update notice reconnection", () => {
  beforeEach(() => {
    installLocalStorage();
    installFakeWebSocket();
  });

  it("preserves a Pi-only update snooze across bootstrap replacement", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            version: "0.3.0",
            piVersion: "0.84.2",
            snapshot: activeSnapshot(),
          }),
        };
      }
      if (url.startsWith("/api/pi-update")) {
        return {
          body: {
            currentVersion: "0.84.2",
            pi: {
              kind: "available",
              latestVersion: "0.84.3",
              releaseUrl: "https://pi.dev/changelog",
            },
            extensions: { kind: "none" },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      }
      return undefined;
    });

    const store = new AppStore();
    await store.init("token");
    store.checkPiUpdate();
    await vi.waitFor(() =>
      expect(store.getState().piUpdateChecking).toBe(false),
    );
    expect(store.getState().piUpdateCheck?.pi.kind).toBe("available");

    store.snoozeUpdate();
    const snoozedUntil = store.getState().updateSnoozedUntil;
    expect(snoozedUntil).not.toBeNull();

    await store.init("token");

    expect(store.getState().updateSnoozedUntil).toBe(snoozedUntil);
  });
});
