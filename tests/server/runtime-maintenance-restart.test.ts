import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRestartController } from "../../server/host-restart.js";
import { type PiRpcOptions, type PiRpcProcess } from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

import {
  FakeRpc,
  TEST_CWD,
  record,
  waitForReady,
  preview,
  catalog,
  trackedAttachmentStore,
  deferredSignal,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("maintenance restart admission", () => {
  afterEach(() => vi.useRealTimers());

  function idleRuntime() {
    return new RuntimeController(
      catalog([]),
      trackedAttachmentStore(),
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
  }

  it.each(["start-error", "transport-exit", "startup-dialog"])(
    "allows a fresh ordinary restart after confirmed retirement of a %s",
    async (failure) => {
      const stopStarted = deferredSignal();
      const stopped = deferredSignal();
      const runtime = new RuntimeController(
        catalog([record("a", "/tmp")]),
        trackedAttachmentStore(),
        (options) => {
          const worker = new FakeRpc(options);
          worker.start = async () => {
            if (failure === "startup-dialog") {
              worker.emit("event", {
                type: "extension_ui_request",
                id: "startup-confirm",
                method: "confirm",
                title: "Startup confirmation",
                message: "Confirm?",
              });
            } else {
              const error = new Error("Pi failed during startup");
              if (failure === "transport-exit") worker.emit("exit", error);
              throw error;
            }
          };
          worker.stop = async () => {
            stopStarted.resolve();
            await stopped.promise;
          };
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      const submit = vi.fn(async (_all: boolean, commit: () => boolean) => ({
        code: commit() ? 0 : 1,
      }));
      const controller = new HostRestartController(runtime, {
        inspect: async () => true,
        prepare: async () => {},
        request: submit,
      });
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
          expect((await controller.status()).operation).toMatchObject({
            phase: "rejected",
            busyReason: "in-flight-operation",
          }),
        );
        expect(submit).not.toHaveBeenCalled();

        stopped.resolve();
        const slot = (
          runtime as unknown as { slots: Map<string, RuntimeSlot> }
        ).slots.get("a")!;
        await vi.waitFor(() => {
          expect(slot.activeOperations).toBe(0);
          expect(slot.stopping).toBeNull();
        });
        expect(slot.process).toBeNull();
        expect(slot.runState).toBe("failed");
        // A historical rejection remains immutable; a new ordinary request
        // must re-evaluate current work without requiring interruption consent.
        expect(controller.start(intent).phase).toBe("rejected");
        controller.start({ ...intent, operationId: randomUUID() });
        await vi.waitFor(async () =>
          expect((await controller.status()).operation?.phase).toBe(
            "submitted",
          ),
        );
        expect(slot.startupPhase).toBe("idle");
        expect(submit).toHaveBeenCalledOnce();
      } finally {
        stopped.resolve();
        await runtime.close();
      }
    },
  );

  it("keeps a failed startup fenced when actual worker retirement rejects", async () => {
    const stopStarted = deferredSignal();
    const stopGate = deferredSignal();
    const createProcess = vi.fn((options: PiRpcOptions) => {
      const worker = new FakeRpc(options);
      worker.start = async () => {
        throw new Error("Pi failed during startup");
      };
      worker.stop = async () => {
        stopStarted.resolve();
        await stopGate.promise;
        throw new Error("Pi stop unconfirmed");
      };
      return worker as unknown as PiRpcProcess;
    });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      createProcess,
      preview,
    );
    try {
      await runtime.openSession("a");
      await stopStarted.promise;
      stopGate.resolve();
      const slot = (
        runtime as unknown as { slots: Map<string, RuntimeSlot> }
      ).slots.get("a")!;
      await vi.waitFor(() => expect(slot.activeOperations).toBe(0));
      await expect(slot.stopping).rejects.toThrow("Pi stop unconfirmed");
      expect(runtime.reserveMaintenanceRestart()).toEqual({
        kind: "busy",
        reason: "in-flight-operation",
      });
      await expect(runtime.openSession("a")).rejects.toThrow(
        "Pi stop unconfirmed",
      );
      expect(createProcess).toHaveBeenCalledOnce();
    } finally {
      stopGate.resolve();
      await expect(runtime.close()).rejects.toThrow("Pi stop unconfirmed");
    }
  });

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
    const store = trackedAttachmentStore();
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );

    const decision = runtime.reserveMaintenanceRestart();
    expect(decision.kind).toBe("ready");
    await expect(runtime.newSession(TEST_CWD)).rejects.toMatchObject({
      status: 503,
    });
    await runtime.close();
  });

  it("allows explicit interruption of active Pi work while another restart lease stays exclusive", async () => {
    const workers = new Map<string, FakeRpc>();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await waitForReady(runtime);
    const worker = workers.get("a")!;
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
    const workers = new Map<string, FakeRpc>();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await waitForReady(runtime);
    const worker = workers.get("a")!;
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
    const store = trackedAttachmentStore();
    const { promise: gate, resolve: release } = deferredSignal();
    const { promise: reachedPreview, resolve: entered } = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        entered();
        await gate;
        return preview(session);
      },
    );

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
