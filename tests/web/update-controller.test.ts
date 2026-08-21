// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AvailableUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import { UpdateController } from "../../src/controllers/update-controller";

interface State {
  availableUpdate: AvailableUpdate | null;
  updateSnoozedUntil: number | null;
}

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

function available(latestVersion = "1.1.0"): UpdateCheckResponse {
  return {
    kind: "available",
    update: {
      currentVersion: "1.0.0",
      latestVersion,
      releaseUrl: `https://github.com/example/inspire/releases/tag/v${latestVersion}`,
    },
  };
}

function harness(initialResponse: UpdateCheckResponse = available()) {
  let state: State = { availableUpdate: null, updateSnoozedUntil: null };
  let response = initialResponse;
  let transportGeneration = 1;
  const api = { update: vi.fn(async () => response) };
  const controller = new UpdateController({
    state: () => state,
    patch: (patch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => transportGeneration,
  });
  return {
    controller,
    api,
    state: () => state,
    respondWith: (next: UpdateCheckResponse) => {
      response = next;
    },
    replaceTransport: () => {
      transportGeneration += 1;
      controller.invalidateForTransportReplacement();
    },
  };
}

beforeEach(installLocalStorage);

afterEach(() => {
  vi.useRealTimers();
});

describe("update status controller", () => {
  it("restores an available update after a 24-hour browser-local snooze", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-21T00:00:00Z") });
    const test = harness();
    test.controller.start();
    await Promise.resolve();

    expect(test.state().availableUpdate?.latestVersion).toBe("1.1.0");
    test.controller.snooze();
    expect(test.state().updateSnoozedUntil).toBe(Date.now() + UPDATE_SNOOZE_MS);
    expect(window.localStorage.getItem("inspire.update-snooze")).toContain(
      "1.1.0",
    );

    await vi.advanceTimersByTimeAsync(UPDATE_SNOOZE_MS - 1);
    expect(test.state().updateSnoozedUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.state().updateSnoozedUntil).toBeNull();
    expect(test.state().availableUpdate?.latestVersion).toBe("1.1.0");
  });

  it("shows a newer release without inheriting the previous release's snooze", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-21T00:00:00Z") });
    const test = harness();
    test.controller.start();
    await Promise.resolve();
    test.controller.snooze();

    test.respondWith(available("1.2.0"));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(test.state()).toMatchObject({
      availableUpdate: { latestVersion: "1.2.0" },
      updateSnoozedUntil: null,
    });
  });

  it("does not publish a response owned by a replaced transport", async () => {
    let resolveUpdate!: (response: UpdateCheckResponse) => void;
    const pending = new Promise<UpdateCheckResponse>((resolve) => {
      resolveUpdate = resolve;
    });
    let state: State = { availableUpdate: null, updateSnoozedUntil: null };
    let transportGeneration = 1;
    const api = { update: vi.fn(() => pending) };
    const controller = new UpdateController({
      state: () => state,
      patch: (patch) => {
        state = { ...state, ...patch };
      },
      api: () => api,
      transportGeneration: () => transportGeneration,
    });

    controller.start();
    transportGeneration += 1;
    controller.invalidateForTransportReplacement();
    resolveUpdate(available());
    await pending;
    await Promise.resolve();
    expect(state.availableUpdate).toBeNull();
  });
});
