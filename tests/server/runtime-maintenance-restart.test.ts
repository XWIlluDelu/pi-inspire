import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRestartController } from "../../server/host-restart.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  initializeRuntimeFixture,
  preview,
  schedulingRuntime,
  TEST_CWD,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("maintenance restart admission", () => {
  afterEach(() => vi.useRealTimers());

  function idleRuntime() {
    return schedulingRuntime({ sessions: [] }).runtime;
  }

  it.each(["committed", "released"])(
    "retains busy workers only for a committed Host-only restart (%s)",
    async (phase) => {
      const detach = vi.fn(async () => {});
      const { runtime, workers } = schedulingRuntime({
        configure: (worker) => Object.assign(worker, { detach }),
      });
      await runtime.openSession("a");
      await waitForReady(runtime);
      workers[0]!.emit("event", { type: "agent_start" });
      // Running work does not block a restart that preserves it.
      expect(runtime.reserveMaintenanceRestart(false, true, false).kind).toBe(
        "busy",
      );
      const lease = runtime.reserveMaintenanceRestart(false, false, true);
      if (lease.kind !== "ready") throw new Error("Expected a Host-only lease");
      expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
        "committed",
      );
      if (phase === "released")
        expect(runtime.releaseMaintenanceRestart(lease.leaseId).kind).toBe(
          "released",
        );
      await runtime.close();
      expect(detach).toHaveBeenCalledTimes(phase === "committed" ? 1 : 0);
      expect(workers[0]!.stops).toBe(phase === "released" ? 1 : 0);
    },
  );

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
        async (_all: boolean, commit: () => boolean | Promise<boolean>) => ({
          code: (await commit()) ? 0 : 1,
        }),
      );
      const controller = new HostRestartController(runtime, {
        inspect: async () => ({ host: true, all: true }),
        prepare: async () => {},
        request: submit,
      });
      const rejected = { phase: "rejected", busyReason: "in-flight-operation" };
      try {
        await runtime.openSession("a");
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
          expect((await runtime.snapshot("a")).runState).toBe("failed");
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

  it("rejects an expired lease even after a fresh owner prepares", async () => {
    vi.useFakeTimers();
    const runtime = idleRuntime();
    const old = runtime.reserveMaintenanceRestart();
    if (old.kind !== "ready") throw new Error("Expected idle lease");
    vi.advanceTimersByTime(30_000);
    expect(runtime.commitMaintenanceRestart(old.leaseId)).toEqual({
      kind: "skipped",
      reason: "lease-invalid",
    });
    const fresh = runtime.reserveMaintenanceRestart();
    if (fresh.kind !== "ready") throw new Error("Expected fresh lease");
    expect(fresh.leaseId).not.toBe(old.leaseId);
    expect(runtime.releaseMaintenanceRestart(old.leaseId).kind).toBe("skipped");
    expect(runtime.commitMaintenanceRestart(old.leaseId).kind).toBe("skipped");
    expect(runtime.commitMaintenanceRestart(fresh.leaseId).kind).toBe(
      "committed",
    );
    await runtime.close();
  });

  it("never expires a committed drain and rejects duplicate or foreign commits", async () => {
    vi.useFakeTimers();
    const runtime = idleRuntime();
    const lease = runtime.reserveMaintenanceRestart();
    if (lease.kind !== "ready") throw new Error("Expected idle lease");
    expect(runtime.commitMaintenanceRestart("foreign").kind).toBe("skipped");
    expect(runtime.commitMaintenanceRestart(lease.leaseId)).toEqual({
      kind: "committed",
      leaseId: lease.leaseId,
    });
    expect(runtime.commitMaintenanceRestart(lease.leaseId)).toEqual({
      kind: "skipped",
      reason: "lease-already-committed",
    });
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    expect(runtime.releaseMaintenanceRestart("foreign").kind).toBe("skipped");
    expect(runtime.reserveMaintenanceRestart().kind).toBe("busy");
    expect(runtime.releaseMaintenanceRestart(lease.leaseId)).toEqual({
      kind: "released",
    });
    expect(runtime.reserveMaintenanceRestart().kind).toBe("ready");
    await runtime.close();
  });

  it("release cancels a reordered commit and cannot release the next owner", async () => {
    const runtime = idleRuntime();
    const lease = runtime.reserveMaintenanceRestart();
    if (lease.kind !== "ready") throw new Error("Expected idle lease");
    expect(runtime.releaseMaintenanceRestart(lease.leaseId).kind).toBe(
      "released",
    );
    expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
      "skipped",
    );
    const next = runtime.reserveMaintenanceRestart();
    expect(next.kind).toBe("ready");
    expect(runtime.releaseMaintenanceRestart(lease.leaseId).kind).toBe(
      "skipped",
    );
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    await runtime.close();
  });

  it("fences every new runtime command after an idle lease", async () => {
    const { runtime } = schedulingRuntime({
      sessions: [],
    });

    const decision = runtime.reserveMaintenanceRestart();
    expect(decision.kind).toBe("ready");
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    await runtime.close();
  });

  it("allows explicit interruption of active Pi work while another restart lease stays exclusive", async () => {
    const { runtime, workers } = schedulingRuntime();
    await runtime.openSession("a");
    await waitForReady(runtime);
    const worker = workers[0]!;
    worker.emit("event", {
      type: "queue_update",
      steering: ["pending input"],
      followUp: [],
    });
    expect(runtime.reserveMaintenanceRestart()).toEqual({
      kind: "busy",
      reason: "active-work",
    });
    const lease = runtime.reserveMaintenanceRestart(true);
    if (lease.kind !== "ready") throw new Error("Expected forced lease");
    expect(runtime.reserveMaintenanceRestart(true)).toEqual({
      kind: "busy",
      reason: "restart-pending",
    });
    expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
      "committed",
    );
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    await runtime.close();
    expect(worker.stops).toBe(1);
  });

  it("interrupts a genuinely pending manual compaction rather than waiting for its RPC", async () => {
    const { runtime, workers } = schedulingRuntime();
    await runtime.openSession("a");
    await waitForReady(runtime);
    const worker = workers[0]!;
    const { promise: compactStarted, resolve: started } = deferredSignal();
    let cancelCompact!: (error: Error) => void;
    worker.responseOverrides.set("compact", () => {
      started();
      return new Promise((_resolve, reject) => {
        cancelCompact = reject;
      });
    });
    const originalStop = worker.stop.bind(worker);
    vi.spyOn(worker, "stop").mockImplementation(async () => {
      cancelCompact(new Error("worker stopped during compaction"));
      await originalStop();
    });
    const compacting = runtime.nativeCommand({
      sessionId: "a",
      command: "compact",
    });
    // Attach the failure observer before the worker can be stopped.
    const settledCompact = compacting.catch((error: unknown) => error);
    await compactStarted;
    expect(runtime.reserveMaintenanceRestart()).toEqual({
      kind: "busy",
      reason: "active-work",
    });
    const lease = runtime.reserveMaintenanceRestart(true);
    if (lease.kind !== "ready") throw new Error("Expected forced lease");
    expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
      "committed",
    );
    await runtime.close();
    expect(worker.stops).toBe(1);
    await expect(settledCompact).resolves.toBeInstanceOf(Error);
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
