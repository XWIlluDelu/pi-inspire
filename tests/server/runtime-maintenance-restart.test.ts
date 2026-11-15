import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deferredSignal,
  disposeIsolatedRuntimeFixture,
  initializeIsolatedRuntimeFixture,
  schedulingRuntime,
  startWorker,
  TEST_CWD,
} from "./fixtures/runtime.js";

beforeEach(initializeIsolatedRuntimeFixture);
afterEach(disposeIsolatedRuntimeFixture);

describe("maintenance restart admission", () => {
  afterEach(() => vi.useRealTimers());

  function idleRuntime() {
    return schedulingRuntime({ sessions: [] }).runtime;
  }

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
});
