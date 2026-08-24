// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AvailableUpdate,
  type PiUpdateCheckResponse,
  UPDATE_SNOOZE_MS,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import { UpdateController } from "../../src/controllers/update-controller";

interface State {
  version: string;
  piVersion: string;
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
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
  let state: State = {
    version: "1.0.0",
    piVersion: "0.84.2",
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    availableUpdate: null,
    updateSnoozedUntil: null,
  };
  let response = initialResponse;
  let transportGeneration = 1;
  let piResponse: PiUpdateCheckResponse = {
    currentVersion: "0.84.2",
    pi: {
      kind: "available",
      latestVersion: "0.84.3",
      releaseUrl: "https://pi.dev/changelog",
    },
    extensions: { kind: "none" },
  };
  const api = {
    update: vi.fn(async () => response),
    piUpdate: vi.fn(async () => piResponse),
  };
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
    respondPiWith: (next: PiUpdateCheckResponse) => {
      piResponse = next;
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
    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateChecking).toBe(false),
    );

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
    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateChecking).toBe(false),
    );
    test.controller.snooze();

    test.respondWith(available("1.2.0"));
    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateChecking).toBe(false),
    );
    expect(test.state()).toMatchObject({
      availableUpdate: { latestVersion: "1.2.0" },
      updateSnoozedUntil: null,
    });
  });

  it("runs the two manual checks independently with cache bypass", async () => {
    const test = harness({ kind: "unreleased" });

    test.controller.refreshPi();
    await vi.waitFor(() => expect(test.state().piUpdateChecking).toBe(false));
    expect(test.api.piUpdate).toHaveBeenCalledWith(true);
    expect(test.state().piUpdateCheck?.pi).toMatchObject({
      kind: "available",
      latestVersion: "0.84.3",
    });

    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateChecking).toBe(false),
    );
    expect(test.api.update).toHaveBeenCalledWith(true);
    expect(test.state().inspireUpdateCheck).toEqual({ kind: "unreleased" });
  });

  it("checks both sources once on the first accepted prompt after 08:00 local time", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 21, 7, 59) });
    const test = harness({ kind: "current" });

    test.controller.start();
    expect(test.api.update).not.toHaveBeenCalled();
    expect(test.api.piUpdate).not.toHaveBeenCalled();
    test.controller.promptAccepted();
    expect(test.api.update).not.toHaveBeenCalled();
    expect(test.api.piUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(2026, 7, 21, 8, 0));
    test.controller.promptAccepted();
    await Promise.resolve();
    expect(test.api.update).toHaveBeenLastCalledWith(false);
    expect(test.api.piUpdate).toHaveBeenLastCalledWith(false);
    expect(window.localStorage.getItem("inspire.update-check-day")).toBe(
      "2026-08-21",
    );

    test.controller.promptAccepted();
    expect(test.api.update).toHaveBeenCalledTimes(1);
    expect(test.api.piUpdate).toHaveBeenCalledTimes(1);

    const reloaded = harness({ kind: "current" });
    reloaded.controller.start();
    reloaded.controller.promptAccepted();
    expect(reloaded.api.update).not.toHaveBeenCalled();
    expect(reloaded.api.piUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(2026, 7, 22, 8, 0));
    reloaded.controller.promptAccepted();
    await Promise.resolve();
    expect(reloaded.api.update).toHaveBeenCalledTimes(1);
    expect(reloaded.api.piUpdate).toHaveBeenCalledTimes(1);
  });

  it("snoozes the combined update identity and reveals newly changed updates", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 21, 9, 0) });
    const test = harness();
    test.controller.refreshPi();
    await vi.waitFor(() => expect(test.state().piUpdateChecking).toBe(false));
    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateChecking).toBe(false),
    );

    test.controller.snooze();
    expect(test.state().updateSnoozedUntil).not.toBeNull();
    expect(window.localStorage.getItem("inspire.update-snooze")).toContain(
      "0.84.3",
    );

    test.respondPiWith({
      currentVersion: "0.84.2",
      pi: {
        kind: "available",
        latestVersion: "0.84.4",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: { kind: "none" },
    });
    test.controller.refreshPi();
    await vi.waitFor(() => expect(test.state().piUpdateChecking).toBe(false));
    expect(test.state().updateSnoozedUntil).toBeNull();
  });

  it("does not publish a response owned by a replaced transport", async () => {
    let resolveUpdate!: (response: UpdateCheckResponse) => void;
    const pending = new Promise<UpdateCheckResponse>((resolve) => {
      resolveUpdate = resolve;
    });
    let state: State = {
      version: "1.0.0",
      piVersion: "0.84.2",
      inspireUpdateCheck: null,
      piUpdateCheck: null,
      inspireUpdateChecking: false,
      piUpdateChecking: false,
      availableUpdate: null,
      updateSnoozedUntil: null,
    };
    let transportGeneration = 1;
    const api = {
      update: vi.fn(() => pending),
      piUpdate: vi.fn(async () => ({
        currentVersion: "0.84.2",
        pi: { kind: "current" as const, latestVersion: "0.84.2" },
        extensions: { kind: "none" as const },
      })),
    };
    const controller = new UpdateController({
      state: () => state,
      patch: (patch) => {
        state = { ...state, ...patch };
      },
      api: () => api,
      transportGeneration: () => transportGeneration,
    });

    controller.refreshInspire();
    transportGeneration += 1;
    controller.invalidateForTransportReplacement();
    resolveUpdate(available());
    await pending;
    await Promise.resolve();
    expect(state.availableUpdate).toBeNull();
  });
});
