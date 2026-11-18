// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HostUpdateStatus,
  type PiUpdateCheckResponse,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import { type Api, ApiError } from "../../src/api";
import { UpdateController } from "../../src/controllers/update-controller";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

interface State {
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
    installedVersion: "0.84.2",
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

function harness() {
  let state: State = {
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
  const api = {
    update: vi.fn(async (_force?: boolean) =>
      updateStatus(2, { inspireUpdateCheck: available() }),
    ),
    piUpdate: vi.fn<(force?: boolean) => Promise<HostUpdateStatus>>(),
    snoozeUpdate: vi.fn<(identity: string) => Promise<HostUpdateStatus>>(),
  };
  const json = ((
    name: string,
    input: {
      query?: { kind: string; refresh: string };
      body?: { identity: string };
    },
  ) => {
    if (name === "snoozeUpdate") return api.snoozeUpdate(input.body!.identity);
    const query = input.query!;
    return (query.kind === "pi" ? api.piUpdate : api.update)(
      query.refresh === "1",
    );
  }) as Api["json"];
  let current = { json };
  const controller = new UpdateController({
    state: () => state,
    patch: (patch) => {
      state = { ...state, ...patch };
    },
    api: () => current,
  });
  return {
    controller,
    api,
    state: () => state,
    bootstrap: (status: HostUpdateStatus) => {
      state = { ...state, ...controller.bootstrap(status) };
    },
    replaceTransport: () => {
      current = { json };
      controller.invalidateForTransportReplacement();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("update status controller", () => {
  it("reports exhausted and non-transient failures independently and preserves prior results", async () => {
    vi.useFakeTimers();
    const test = harness();
    const previous = available("1.0.1");
    test.bootstrap(
      updateStatus(1, {
        inspireUpdateCheck: previous,
        piUpdateCheck: piAvailable("0.84.2"),
      }),
    );
    test.api.update.mockRejectedValue(new ApiError(403, "Forbidden"));
    test.api.piUpdate.mockRejectedValue(new ApiError(503, "Unavailable"));
    test.controller.refreshInspire();
    test.controller.refreshPi();
    await vi.runAllTimersAsync();
    expect(test.api.update).toHaveBeenCalledOnce();
    expect(test.api.piUpdate.mock.calls.length).toBeGreaterThan(1);
    expect(test.state()).toMatchObject({
      inspireUpdateCheck: previous,
      piUpdateCheck: piAvailable("0.84.2"),
      inspireUpdateRequestPending: false,
      piUpdateRequestPending: false,
      inspireUpdateRequestError: "Couldn't check INSΠRE updates.",
      piUpdateRequestError: "Couldn't check Pi and extension updates.",
    });

    test.api.piUpdate.mockResolvedValue(
      updateStatus(2, {
        inspireUpdateCheck: previous,
        piUpdateCheck: piAvailable(),
      }),
    );
    test.controller.refreshPi();
    await vi.runAllTimersAsync();
    expect(test.api.piUpdate).toHaveBeenLastCalledWith(true);
    expect(test.state()).toMatchObject({
      piUpdateCheck: piAvailable(),
      piUpdateRequestError: null,
      inspireUpdateRequestError: "Couldn't check INSΠRE updates.",
    });
    test.controller.applySnapshot(
      updateStatus(3, {
        inspireUpdateChecking: true,
        inspireUpdateCheck: previous,
        piUpdateCheck: piAvailable(),
      }),
    );
    expect(test.state().inspireUpdateRequestError).toBeNull();
  });

  it("stops scheduled recovery and ignores lost HTTP replies once the Host observes execution", async () => {
    vi.useFakeTimers();
    const test = harness();
    const pending = deferred<HostUpdateStatus>();
    test.api.update.mockRejectedValue(new ApiError(503, "Unavailable"));
    test.api.piUpdate.mockReturnValueOnce(pending.promise);
    test.controller.refreshInspire();
    test.controller.refreshPi();
    await vi.advanceTimersByTimeAsync(0);

    test.controller.applyEvent({
      type: "update_status",
      updateStatus: updateStatus(1, {
        inspireUpdateChecking: true,
        piUpdateChecking: true,
      }),
    });
    pending.reject(new Error("HTTP response lost"));
    await vi.runAllTimersAsync();

    expect(test.api.update).toHaveBeenCalledOnce();
    expect(test.api.piUpdate).toHaveBeenCalledOnce();
    expect(test.state()).toMatchObject({
      inspireUpdateChecking: true,
      piUpdateChecking: true,
      inspireUpdateRequestPending: false,
      piUpdateRequestPending: false,
      inspireUpdateRequestError: null,
      piUpdateRequestError: null,
    });
    test.controller.applySnapshot(
      updateStatus(2, {
        inspireUpdateCheck: available(),
        piUpdateCheck: piAvailable(),
      }),
    );
    expect(test.state()).toMatchObject({
      inspireUpdateChecking: false,
      piUpdateChecking: false,
      inspireUpdateCheck: available(),
      piUpdateCheck: piAvailable(),
    });
  });

  it("retires a replaced transport's recovery and late reply while retaining observed Host work", async () => {
    vi.useFakeTimers();
    const test = harness();
    const pending = deferred<HostUpdateStatus>();
    test.api.update.mockRejectedValueOnce(new ApiError(503, "Unavailable"));
    test.api.piUpdate.mockReturnValueOnce(pending.promise);
    test.controller.refreshInspire();
    test.controller.refreshPi();
    await vi.advanceTimersByTimeAsync(0);
    test.controller.applySnapshot(updateStatus(1, { piUpdateChecking: true }));
    test.replaceTransport();
    pending.resolve(updateStatus(10, { piUpdateCheck: piAvailable() }));
    await vi.runAllTimersAsync();

    expect(test.api.update).toHaveBeenCalledOnce();
    expect(test.state()).toMatchObject({
      inspireUpdateRequestPending: false,
      inspireUpdateRequestError: null,
      piUpdateChecking: true,
      piUpdateCheck: null,
    });
    test.bootstrap(updateStatus(0));
    expect(test.state().piUpdateChecking).toBe(false);
    test.controller.refreshInspire();
    await vi.runAllTimersAsync();
    expect(test.state().inspireUpdateCheck).toEqual(available());
  });

  it("keeps an in-flight check across a same-revision snapshot and discards an older HTTP result", async () => {
    vi.useFakeTimers();
    const test = harness();
    const initial = updateStatus(1);
    const pending = deferred<HostUpdateStatus>();
    test.bootstrap(initial);
    test.api.update.mockReturnValueOnce(pending.promise);

    test.controller.refreshInspire();
    test.controller.applySnapshot(initial);
    test.controller.refreshInspire();
    expect(test.api.update).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.state().inspireUpdateRequestPending).toBe(true);

    const newer = updateStatus(8, {
      inspireUpdateCheck: available("1.2.0"),
      availableUpdateIdentity: "newer-set",
      updateSnoozedUntil: 3_000_000,
    });
    test.controller.applyEvent({ type: "update_status", updateStatus: newer });
    pending.resolve(
      updateStatus(7, {
        inspireUpdateCheck: available(),
        availableUpdateIdentity: "older-set",
      }),
    );
    await vi.runAllTimersAsync();
    expect(test.state()).toMatchObject({
      inspireUpdateCheck: newer.inspireUpdateCheck,
      availableUpdateIdentity: newer.availableUpdateIdentity,
      updateSnoozedUntil: newer.updateSnoozedUntil,
      inspireUpdateRequestPending: false,
    });
  });

  it("dismisses an update immediately and keeps it dismissed if the write fails", async () => {
    vi.useFakeTimers();
    const test = harness();
    const status = updateStatus(4, {
      inspireUpdateCheck: available(),
      availableUpdateIdentity: "host-issued-set",
    });
    test.bootstrap(status);
    test.api.snoozeUpdate.mockRejectedValueOnce(new Error("Offline"));
    test.controller.snooze();
    expect(test.state().updateSnoozedUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    test.replaceTransport();
    test.bootstrap(status);
    expect(test.state().updateSnoozedUntil).not.toBeNull();
    test.controller.applySnapshot({ ...status, revision: 5, availableUpdateIdentity: "new-set" });
    expect(test.state().updateSnoozedUntil).toBeNull();
  });
});

it("reconciles Host update state from the stream and closes it on an invalid status", async () => {
  installFakeWebSocket();
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
          startupSessionId: "s1",
        }),
      };
    }
    if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
    return undefined;
  });

  const store = new AppStore();
  await store.init();
  expect(store.getState().piUpdateCheck?.pi.kind).toBe("available");

  const socket = FakeWebSocket.instances.at(-1)!;
  authoritative = updateStatus(4, {
    piUpdateCheck: piAvailable(),
    availableUpdateIdentity: '[["pi","0.84.3"]]',
    updateSnoozedUntil: 4_000_000,
  });
  socket.join(activeSnapshot(), { updateStatus: authoritative });
  expect(store.getState().updateSnoozedUntil).toBe(4_000_000);

  vi.useFakeTimers();
  const close = vi.spyOn(socket, "close");
  socket.emit({ type: "update_status", updateStatus: { revision: "new" } });
  expect(close).toHaveBeenCalledOnce();
  expect(store.getState().updateSnoozedUntil).toBe(4_000_000);
});
