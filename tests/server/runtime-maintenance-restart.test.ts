import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRestartController } from "../../server/host-restart.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import type { HostRestartScope } from "../../shared/host-restart.js";

import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureWorkspace,
  initializeRuntimeFixture,
  preview,
  schedulingRuntime,
  startWorker,
  TEST_CWD,
} from "./fixtures/runtime.js";

beforeEach(async () => {
  await initializeRuntimeFixture();
  const pi = await nativePiWorkspace(
    "pi-",
    { defaultProjectTrust: "never" },
    fixtureWorkspace,
  );
  stubNativePiEnvironment(pi.env);
});
afterEach(async () => {
  try {
    await disposeRuntimeFixture();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("maintenance restart admission", () => {
  afterEach(() => vi.useRealTimers());

  function idleRuntime() {
    return schedulingRuntime({ sessions: [] }).runtime;
  }

  it.each(["completed", "unconfirmed"] as const)(
    "fences a failed startup until its worker retirement is %s",
    async (retirement) => {
      const stopStarted = deferredSignal();
      const stopGate = deferredSignal();
      const { runtime, workers } = schedulingRuntime({
        configure(worker) {
          worker.start = async () => {
            const error = new Error("Pi failed during startup");
            if (retirement === "completed") worker.emit("exit", error);
            throw error;
          };
          worker.stop = async () => {
            stopStarted.resolve();
            await stopGate.promise;
            if (retirement === "unconfirmed")
              throw new Error("Pi stop unconfirmed");
          };
        },
      });
      const submit = vi.fn(
        async (
          _scope: HostRestartScope,
          commit: () => boolean | Promise<boolean>,
        ) => ({
          code: (await commit()) ? 0 : 1,
        }),
      );
      const controller = new HostRestartController(runtime, {
        inspect: async () => ({ host: true }),
        prepare: async () => {},
        request: submit,
      });
      const rejected = { phase: "rejected", busyReason: "in-flight-operation" };
      try {
        await runtime.openSession("a");
        void startWorker(runtime).catch(() => undefined);
        await stopStarted.promise;
        const intent = {
          hostId: (await controller.status()).hostId,
          operationId: randomUUID(),
          scope: "host" as const,
        };
        controller.start(intent);
        await vi.waitFor(async () =>
          expect((await controller.status()).operation).toMatchObject(rejected),
        );
        expect(submit).not.toHaveBeenCalled();

        stopGate.resolve();
        const slot = (
          runtime as unknown as { slots: Map<string, RuntimeSlot> }
        ).slots.get("a")!;
        await vi.waitFor(() => expect(slot.activeOperations).toBe(0));
        if (retirement === "unconfirmed") {
          await expect(slot.stopping).rejects.toThrow("Pi stop unconfirmed");
          await expect(runtime.openSession("a")).rejects.toThrow(
            "Pi stop unconfirmed",
          );
          expect(workers).toHaveLength(1);
        } else {
          await vi.waitFor(() => expect(slot.stopping).toBeNull());
          expect(
            (await runtime.snapshot("a")).sessionStatuses["a"]?.runState,
          ).toBe("failed");
        }

        expect(controller.start(intent).phase).toBe("rejected");
        const retry = { ...intent, operationId: randomUUID() };
        controller.start(retry);
        await vi.waitFor(async () =>
          expect((await controller.status()).operation).toMatchObject({
            id: retry.operationId,
            ...(retirement === "unconfirmed"
              ? rejected
              : { phase: "submitted" }),
          }),
        );
        expect(submit).toHaveBeenCalledTimes(
          retirement === "unconfirmed" ? 0 : 1,
        );
      } finally {
        stopGate.resolve();
        if (retirement === "unconfirmed")
          await expect(runtime.close()).rejects.toThrow("Pi stop unconfirmed");
        else await runtime.close();
      }
    },
  );

  it("fences expired, released and foreign identities and keeps a committed drain", async () => {
    vi.useFakeTimers();
    const runtime = idleRuntime();
    const reserve = () => {
      const lease = runtime.reserveMaintenanceRestart();
      if (lease.kind !== "ready") throw new Error("Expected idle lease");
      return lease.leaseId;
    };
    const expired = reserve();
    vi.advanceTimersByTime(30_000);
    expect(runtime.commitMaintenanceRestart(expired)).toEqual({
      kind: "skipped",
      reason: "lease-invalid",
    });

    const released = reserve();
    expect(runtime.releaseMaintenanceRestart(released).kind).toBe("released");
    const current = reserve();
    expect(new Set([expired, released, current]).size).toBe(3);
    for (const retired of [expired, released, "foreign"]) {
      expect(runtime.releaseMaintenanceRestart(retired).kind).toBe("skipped");
      expect(runtime.commitMaintenanceRestart(retired).kind).toBe("skipped");
    }
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    expect(runtime.commitMaintenanceRestart(current)).toEqual({
      kind: "committed",
      leaseId: current,
    });
    expect(runtime.commitMaintenanceRestart(current)).toEqual({
      kind: "skipped",
      reason: "lease-already-committed",
    });
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(runtime.reserveMaintenanceRestart().kind).toBe("busy");
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    expect(runtime.releaseMaintenanceRestart(current).kind).toBe("released");
    reserve();
    await runtime.close();
  });

  it("keeps pending and running Pi work behind one forced restart lease", async () => {
    const { runtime, workers } = schedulingRuntime();
    await runtime.openSession("a");
    await startWorker(runtime);
    const worker = workers[0]!;
    const active = { kind: "busy", reason: "active-work" };
    worker.emit("event", {
      type: "queue_update",
      steering: ["pending input"],
      followUp: [],
    });
    expect(runtime.reserveMaintenanceRestart()).toEqual(active);
    worker.emit("event", { type: "queue_update", steering: [], followUp: [] });

    const compactStarted = deferredSignal();
    const compactRpc = Promise.withResolvers<void>();
    worker.responseOverrides.set("compact", () => {
      compactStarted.resolve();
      return compactRpc.promise;
    });
    const originalStop = worker.stop.bind(worker);
    vi.spyOn(worker, "stop").mockImplementation(async () => {
      compactRpc.reject(new Error("worker stopped during compaction"));
      await originalStop();
    });
    const compact = runtime.nativeCommand({
      sessionId: "a",
      command: "compact",
    });
    const settled = compact.catch((error: unknown) => error);
    await compactStarted.promise;
    expect(runtime.reserveMaintenanceRestart()).toEqual(active);
    const lease = runtime.reserveMaintenanceRestart(true);
    if (lease.kind !== "ready") throw new Error("Expected forced lease");
    expect(runtime.reserveMaintenanceRestart(true)).toEqual({
      kind: "busy",
      reason: "restart-pending",
    });
    expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
      "committed",
    );
    await runtime.close();
    expect(worker.stops).toBe(1);
    await expect(settled).resolves.toBeInstanceOf(Error);
  });

  it("does not grant an idle-only lease while an open request is still in flight", async () => {
    const { promise: gate, resolve: release } = deferredSignal();
    const { promise: reachedPreview, resolve: entered } = deferredSignal();
    const { runtime } = fakeRuntime({
      openSessionProjection: async (session) => {
        entered();
        await gate;
        return preview(session);
      },
    });

    const opening = runtime.openSession("a");
    await reachedPreview;
    expect(runtime.reserveMaintenanceRestart()).toEqual({
      kind: "busy",
      reason: "in-flight-operation",
    });
    release();
    await opening;
    await runtime.close();
  });
});
