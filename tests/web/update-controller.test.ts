// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HostUpdateStatus,
  type InspireUpdateCheckResult,
  type PiUpdateCheckResponse,
  type PiUpdateCheckResult,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import { ApiError } from "../../src/api";
import { UpdateController } from "../../src/controllers/update-controller";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

interface State {
  version: string;
  piVersion: string;
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  inspireUpdateRequestPending: boolean;
  piUpdateRequestPending: boolean;
  inspireUpdateRequestError: string | null;
  piUpdateRequestError: string | null;
  availableUpdateIdentity: string | null;
  updateSnoozedUntil: number | null;
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

function piAvailable(latestVersion = "0.84.3"): PiUpdateCheckResponse {
  return {
    currentVersion: "0.84.2",
    pi: {
      kind: "available",
      latestVersion,
      releaseUrl: "https://pi.dev/changelog",
    },
    extensions: { kind: "none" },
  };
}

function updateStatus(
  revision: number,
  overrides: Partial<HostUpdateStatus> = {},
): HostUpdateStatus {
  return {
    revision,
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    availableUpdateIdentity: null,
    updateSnoozedUntil: null,
    ...overrides,
  };
}

function inspireResult(
  updateStatus: HostUpdateStatus,
): InspireUpdateCheckResult {
  return {
    ...(updateStatus.inspireUpdateCheck ?? { kind: "unavailable" }),
    updateStatus,
  };
}

function piResult(updateStatus: HostUpdateStatus): PiUpdateCheckResult {
  return {
    ...(updateStatus.piUpdateCheck ?? {
      currentVersion: "0.84.2",
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    }),
    updateStatus,
  };
}

function harness() {
  let state: State = {
    version: "1.0.0",
    piVersion: "0.84.2",
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    inspireUpdateRequestPending: false,
    piUpdateRequestPending: false,
    inspireUpdateRequestError: null,
    piUpdateRequestError: null,
    availableUpdateIdentity: null,
    updateSnoozedUntil: null,
  };
  let inspireResponse = updateStatus(2, {
    inspireUpdateCheck: available(),
    availableUpdateIdentity: '[["inspire","1.1.0"]]',
  });
  let piResponse = updateStatus(4, {
    inspireUpdateCheck: available(),
    piUpdateCheck: piAvailable(),
    availableUpdateIdentity: '[["inspire","1.1.0"],["pi","0.84.3"]]',
  });
  let snoozeResponse = updateStatus(5, {
    inspireUpdateCheck: available(),
    piUpdateCheck: piAvailable(),
    availableUpdateIdentity: '[["inspire","1.1.0"],["pi","0.84.3"]]',
    updateSnoozedUntil: 2_000_000,
  });
  let transportGeneration = 1;
  const notify = vi.fn();
  const api = {
    update: vi.fn(async () => inspireResult(inspireResponse)),
    piUpdate: vi.fn(async () => piResult(piResponse)),
    snoozeUpdate: vi.fn(async () => snoozeResponse),
  };
  const controller = new UpdateController({
    state: () => state,
    patch: (patch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    transportGeneration: () => transportGeneration,
    notify,
  });
  return {
    controller,
    api,
    notify,
    state: () => state,
    bootstrap: (status: HostUpdateStatus) => {
      state = { ...state, ...controller.bootstrap(status) };
    },
    respondInspireWith: (status: HostUpdateStatus) => {
      inspireResponse = status;
    },
    respondPiWith: (status: HostUpdateStatus) => {
      piResponse = status;
    },
    respondSnoozeWith: (status: HostUpdateStatus) => {
      snoozeResponse = status;
    },
    replaceTransport: () => {
      transportGeneration += 1;
      controller.invalidateForTransportReplacement();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("update status controller", () => {
  it("recovers a transient check request without replacing known results or surfacing a temporary error", async () => {
    vi.useFakeTimers();
    const test = harness();
    test.bootstrap(updateStatus(1, { inspireUpdateCheck: available("1.0.1") }));
    test.api.update.mockRejectedValueOnce(new ApiError(503, "Unavailable"));
    test.controller.refreshInspire();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.state().inspireUpdateRequestPending).toBe(true);
    expect(test.state().inspireUpdateRequestError).toBeNull();
    expect(test.state().inspireUpdateCheck).toEqual(available("1.0.1"));
    test.controller.refreshInspire();
    await vi.runAllTimersAsync();
    expect(test.api.update).toHaveBeenCalledTimes(2);
    expect(test.state().inspireUpdateRequestPending).toBe(false);
    expect(test.state().inspireUpdateRequestError).toBeNull();
    expect(test.state().inspireUpdateCheck).toEqual(available());
    expect(test.notify).not.toHaveBeenCalled();
  });

  it.each([403, 503])(
    "settles a failed HTTP %s check locally and clears its error on a successful check",
    async (status) => {
      vi.useFakeTimers();
      const test = harness();
      test.bootstrap(updateStatus(1, { piUpdateCheck: piAvailable("0.84.2") }));
      test.api.piUpdate.mockRejectedValue(new ApiError(status, "Unavailable"));
      test.controller.refreshPi();
      await vi.runAllTimersAsync();
      expect(test.api.piUpdate).toHaveBeenCalledTimes(status === 503 ? 4 : 1);
      expect(test.state().piUpdateRequestPending).toBe(false);
      expect(test.state().piUpdateRequestError).toBe(
        "Couldn't check Pi and extension updates.",
      );
      expect(test.state().piUpdateCheck).toEqual(piAvailable("0.84.2"));
      test.api.piUpdate.mockResolvedValue(
        piResult(updateStatus(2, { piUpdateCheck: piAvailable() })),
      );
      test.controller.refreshPi();
      await vi.runAllTimersAsync();
      expect(test.state().piUpdateRequestError).toBeNull();
      expect(test.state().piUpdateCheck).toEqual(piAvailable());
    },
  );

  it("stops recovery when the Host acknowledges the check and clears only that check's error", async () => {
    vi.useFakeTimers();
    const test = harness();
    test.api.piUpdate.mockRejectedValue(new ApiError(403, "Forbidden"));
    test.api.update.mockRejectedValue(new ApiError(503, "Unavailable"));
    test.controller.refreshPi();
    test.controller.refreshInspire();
    await vi.advanceTimersByTimeAsync(0);
    test.controller.applyEvent({
      type: "update_status",
      updateStatus: updateStatus(1, { inspireUpdateChecking: true }),
    });
    expect(test.state().inspireUpdateRequestPending).toBe(false);
    expect(test.state().inspireUpdateRequestError).toBeNull();
    expect(test.state().piUpdateRequestError).not.toBeNull();
    test.controller.applySnapshot(
      updateStatus(2, { inspireUpdateCheck: available() }),
    );
    await vi.runAllTimersAsync();
    expect(test.api.update).toHaveBeenCalledTimes(1);
    expect(test.state().inspireUpdateCheck).toEqual(available());
    test.controller.applySnapshot(
      updateStatus(3, {
        inspireUpdateCheck: available(),
        piUpdateChecking: true,
      }),
    );
    expect(test.state().piUpdateRequestError).toBeNull();
  });

  it("retires scheduled recovery when its transport is replaced", async () => {
    vi.useFakeTimers();
    const test = harness();
    test.api.update.mockRejectedValueOnce(new ApiError(503, "Unavailable"));
    test.controller.refreshInspire();
    await vi.advanceTimersByTimeAsync(0);
    test.replaceTransport();
    await vi.runAllTimersAsync();
    expect(test.api.update).toHaveBeenCalledTimes(1);
    expect(test.state().inspireUpdateRequestPending).toBe(false);
    expect(test.state().inspireUpdateRequestError).toBeNull();
    test.controller.refreshInspire();
    await vi.runAllTimersAsync();
    expect(test.api.update).toHaveBeenCalledTimes(2);
    expect(test.state().inspireUpdateCheck).toEqual(available());
  });

  it("projects one authoritative bootstrap and the two independent manual checks", async () => {
    const test = harness();
    test.bootstrap(updateStatus(0));

    test.controller.refreshPi();
    expect(test.state().piUpdateRequestPending).toBe(true);
    expect(test.state().piUpdateChecking).toBe(false);
    await vi.waitFor(() =>
      expect(test.state().piUpdateRequestPending).toBe(false),
    );
    expect(test.api.piUpdate).toHaveBeenCalledWith(true);
    expect(test.state().piUpdateCheck?.pi).toMatchObject({
      kind: "available",
      latestVersion: "0.84.3",
    });

    test.respondInspireWith(
      updateStatus(6, {
        inspireUpdateCheck: { kind: "unreleased" },
        piUpdateCheck: piAvailable(),
        availableUpdateIdentity: '[["pi","0.84.3"]]',
      }),
    );
    test.controller.refreshInspire();
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateRequestPending).toBe(false),
    );
    expect(test.api.update).toHaveBeenCalledWith(true);
    expect(test.state()).toMatchObject({
      inspireUpdateCheck: { kind: "unreleased" },
      availableUpdateIdentity: '[["pi","0.84.3"]]',
    });
  });

  it("sends the Host-issued identity and adopts its shared snooze", async () => {
    const test = harness();
    test.bootstrap(
      updateStatus(4, {
        inspireUpdateCheck: available(),
        piUpdateCheck: piAvailable(),
        availableUpdateIdentity: '[["inspire","1.1.0"],["pi","0.84.3"]]',
      }),
    );

    test.controller.snooze();
    await vi.waitFor(() =>
      expect(test.state().updateSnoozedUntil).toBe(2_000_000),
    );
    expect(test.api.snoozeUpdate).toHaveBeenCalledWith(
      '[["inspire","1.1.0"],["pi","0.84.3"]]',
    );
  });

  it("adopts Host broadcasts and ignores an older HTTP completion", async () => {
    const test = harness();
    test.bootstrap(updateStatus(1));
    let resolveUpdate!: (status: HostUpdateStatus) => void;
    test.api.update.mockImplementationOnce(
      () =>
        new Promise<InspireUpdateCheckResult>((resolve) => {
          resolveUpdate = (status) => resolve(inspireResult(status));
        }),
    );

    test.controller.refreshInspire();
    expect(
      test.controller.applyEvent({
        type: "update_status",
        updateStatus: updateStatus(8, {
          inspireUpdateCheck: available("1.2.0"),
          availableUpdateIdentity: '[["inspire","1.2.0"]]',
          updateSnoozedUntil: 3_000_000,
        }),
      }),
    ).toBe(true);
    resolveUpdate(
      updateStatus(7, {
        inspireUpdateCheck: available("1.1.0"),
        availableUpdateIdentity: '[["inspire","1.1.0"]]',
      }),
    );
    await vi.waitFor(() =>
      expect(test.state().inspireUpdateCheck).toMatchObject({
        kind: "available",
        update: { latestVersion: "1.2.0" },
      }),
    );
    expect(test.state().updateSnoozedUntil).toBe(3_000_000);
  });

  it.each([false, true])(
    "keeps a Host-observed check authoritative after HTTP loss (completed: %s)",
    async (completed) => {
      vi.useFakeTimers();
      const test = harness();
      test.bootstrap(updateStatus(1));
      let rejectRequest!: (error: Error) => void;
      test.api.update.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRequest = reject;
          }),
      );
      test.controller.refreshInspire();
      test.controller.applyEvent({
        type: "update_status",
        updateStatus: updateStatus(2, { inspireUpdateChecking: true }),
      });
      if (completed)
        test.controller.applySnapshot(
          updateStatus(3, { inspireUpdateCheck: available() }),
        );
      rejectRequest(new Error("HTTP response lost"));
      await vi.runAllTimersAsync();
      expect(test.state().inspireUpdateChecking).toBe(!completed);
      expect(test.state().inspireUpdateRequestPending).toBe(false);
      expect(test.state().inspireUpdateRequestError).toBeNull();
      expect(test.api.update).toHaveBeenCalledTimes(1);
      test.controller.applySnapshot(updateStatus(3));
      expect(test.state().inspireUpdateChecking).toBe(false);
    },
  );

  it("does not publish a response owned by a replaced transport", async () => {
    const test = harness();
    test.bootstrap(updateStatus(1));
    let resolveUpdate!: (status: HostUpdateStatus) => void;
    test.api.update.mockImplementationOnce(
      () =>
        new Promise<InspireUpdateCheckResult>((resolve) => {
          resolveUpdate = (status) => resolve(inspireResult(status));
        }),
    );

    test.controller.refreshInspire();
    test.replaceTransport();
    resolveUpdate(
      updateStatus(2, {
        inspireUpdateCheck: available(),
        availableUpdateIdentity: '[["inspire","1.1.0"]]',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(test.state().inspireUpdateCheck).toBeNull();
    expect(test.state().inspireUpdateRequestPending).toBe(false);
  });

  it("keeps duplicate request guards separate from same-revision Host snapshots", async () => {
    const test = harness();
    test.bootstrap(updateStatus(1));
    let complete!: (result: InspireUpdateCheckResult) => void;
    test.api.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    test.controller.refreshInspire();
    test.controller.applySnapshot(updateStatus(1));
    test.controller.refreshInspire();
    expect(test.api.update).toHaveBeenCalledTimes(1);
    expect(test.state().inspireUpdateRequestPending).toBe(true);
    expect(test.state().inspireUpdateChecking).toBe(false);
    complete(inspireResult(updateStatus(2)));
    await Promise.resolve();
    expect(test.state().inspireUpdateRequestPending).toBe(false);
  });

  it("transport loss retires a local request without declaring Host work finished", () => {
    const test = harness();
    test.bootstrap(updateStatus(2, { inspireUpdateChecking: true }));
    test.replaceTransport();
    expect(test.state().inspireUpdateChecking).toBe(true);
    test.bootstrap(updateStatus(0));
    expect(test.state().inspireUpdateChecking).toBe(false);
  });

  it("fails a malformed Host update event instead of silently diverging", () => {
    const test = harness();
    expect(() =>
      test.controller.applyEvent({
        type: "update_status",
        updateStatus: { revision: "new" },
      }),
    ).toThrow("invalid update status");
  });
});

describe("Host update projection", () => {
  beforeEach(installFakeWebSocket);

  it("closes the bootstrap race with the shared state carried by the stream snapshot", async () => {
    let authoritative = updateStatus(3, {
      piUpdateCheck: piAvailable(),
      availableUpdateIdentity: '[["pi","0.84.3"]]',
    });
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            version: "0.3.0",
            piVersion: "0.84.2",
            updateStatus: authoritative,
            snapshot: activeSnapshot(),
          }),
        };
      }
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });

    const store = new AppStore();
    await store.init("token");
    expect(store.getState().piUpdateCheck?.pi.kind).toBe("available");

    const socket = FakeWebSocket.instances.at(-1)!;
    authoritative = updateStatus(4, {
      piUpdateCheck: piAvailable(),
      availableUpdateIdentity: '[["pi","0.84.3"]]',
      updateSnoozedUntil: 4_000_000,
    });
    FakeWebSocket.bootstrapUpdateStatus = authoritative;
    socket.open(activeSnapshot());
    expect(store.getState().updateSnoozedUntil).toBe(4_000_000);

    await store.init("token");
    expect(store.getState().updateSnoozedUntil).toBe(4_000_000);
  });
});
