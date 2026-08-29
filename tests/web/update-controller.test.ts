// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AvailableUpdate,
  type HostUpdateStatus,
  type InspireUpdateCheckResult,
  type PiUpdateCheckResponse,
  type PiUpdateCheckResult,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import { UpdateController } from "../../src/controllers/update-controller";
import { AppStore } from "../../src/store";
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
  availableUpdate: AvailableUpdate | null;
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
    availableUpdate: null,
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

describe("update status controller", () => {
  it("projects one authoritative bootstrap and the two independent manual checks", async () => {
    const test = harness();
    test.bootstrap(updateStatus(0));

    test.controller.refreshPi();
    expect(test.state().piUpdateChecking).toBe(true);
    await vi.waitFor(() => expect(test.state().piUpdateChecking).toBe(false));
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
      expect(test.state().inspireUpdateChecking).toBe(false),
    );
    expect(test.api.update).toHaveBeenCalledWith(true);
    expect(test.state()).toMatchObject({
      inspireUpdateCheck: { kind: "unreleased" },
      availableUpdate: null,
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
      expect(test.state().availableUpdate?.latestVersion).toBe("1.2.0"),
    );
    expect(test.state().updateSnoozedUntil).toBe(3_000_000);
  });

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
    expect(test.state().availableUpdate).toBeNull();
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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
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
