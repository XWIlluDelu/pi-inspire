import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpcCancelledError, type PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import {
  FakeRpc,
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

describe("RuntimeController compaction lifecycle", () => {
  it("retains bounded summarization retry detail without changing compaction ownership", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    try {
      await runtime.openSession("a");
      await runtime.setAutoRetry("a", true);
      worker.emit("event", { type: "compaction_start", reason: "manual" });
      worker.emit("event", {
        type: "summarization_retry_scheduled",
        attempt: 2,
        maxAttempts: 3,
        errorMessage: "x".repeat(5000),
      });
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) => event.type === "summarization_retry_scheduled",
          ),
        ).toBe(true),
      );
      expect(
        events.find((event) => event.type === "summarization_retry_scheduled")
          ?.errorMessage,
      ).toHaveLength(4000);
      const joined = await runtime.snapshot("a");
      expect(joined).toMatchObject({
        runState: "compacting",
        retry: null,
        summarizationRetry: {
          attempt: 2,
          maxAttempts: 3,
          message: "x".repeat(4000),
        },
      });
      expect((await runtime.snapshot("a")).summarizationRetry).toEqual(
        joined.summarizationRetry,
      );
      for (const type of [
        "summarization_retry_attempt_start",
        "summarization_retry_finished",
      ]) {
        worker.emit("event", { type });
        await new Promise<void>((done) => setImmediate(done));
        expect(await runtime.snapshot("a")).toMatchObject({
          runState: "compacting",
          summarizationRetry: null,
        });
        worker.emit("event", {
          type: "summarization_retry_scheduled",
          attempt: 2,
          maxAttempts: 3,
          errorMessage: "retry",
        });
      }
      worker.emit("event", {
        type: "compaction_end",
        reason: "manual",
        aborted: true,
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "compaction_end")).toBe(
          true,
        ),
      );
      expect(await runtime.snapshot("a")).toMatchObject({
        runState: "aborted",
        summarizationRetry: null,
      });
    } finally {
      await runtime.close();
    }
  });

  it("classifies native standalone cancellation from Pi's event and recovers Pending without replacing its worker", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    const { promise: compactStarted, resolve: started } = deferredSignal();
    let cancelCompact!: (error: Error) => void;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.responseOverrides.set("compact", () => {
        started();
        return new Promise((_resolve, reject) => {
          cancelCompact = reject;
        });
      });
      worker.responseOverrides.set("abort", () => {
        worker.emit("event", {
          type: "compaction_end",
          reason: "manual",
          aborted: true,
        });
        // Hooks can reject with their own diagnostic; no string matching.
        cancelCompact(new Error("Synthetic hook interrupted"));
        return {};
      });
      const compacting = runtime.nativeCommand({
        sessionId: "a",
        command: "compact",
      });
      await compactStarted;
      const pending = runtime.prompt({
        sessionId: "a",
        message: "direction held through compaction",
        behavior: "steer",
      });
      void pending.catch(() => {});
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
      );
      expect(await runtime.abort("a")).toEqual({
        steering: ["direction held through compaction"],
        followUp: [],
      });
      await expect(pending).rejects.toMatchObject({ code: "PROMPT_RECOVERED" });
      await expect(compacting).resolves.toMatchObject({
        command: "compact",
        outcome: "cancelled",
      });
      expect(worker.stops).toBe(0);
      expect(worker.commands.slice(-2).map((command) => command.type)).toEqual([
        "clear_queue",
        "abort",
      ]);
      expect(
        events.filter((event) => event.type === "compaction_end"),
      ).toHaveLength(1);
      expect((await runtime.snapshot()).runState).toBe("aborted");
      await runtime.prompt({ sessionId: "a", message: "new post-Stop input" });
      expect(worker.starts).toBe(1);
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it.each(["confirmed", "rejected"] as const)(
    "retains an unresponsive compaction's writer fence until retirement is %s",
    async (outcome) => {
      let worker!: FakeRpc;
      const runtime = new RuntimeController(
        catalog([record("a", "/tmp")]),
        trackedAttachmentStore(),
        (options) => {
          worker = new FakeRpc(options);
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      const events: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => events.push(event));
      const { promise: compactStarted, resolve: started } = deferredSignal();
      let finishRetirement!: (error?: Error) => void;
      const retirement = new Promise<void>((resolveStopped, rejectStopped) => {
        finishRetirement = (error) =>
          error ? rejectStopped(error) : resolveStopped();
      });
      let rejectCompact!: (error: Error) => void;
      try {
        await runtime.openSession("a");
        await waitForReady(runtime);
        worker.responseOverrides.set("compact", () => {
          started();
          return new Promise((_resolve, reject) => {
            rejectCompact = reject;
          });
        });
        vi.spyOn(worker, "stop").mockImplementation(async (command) => {
          const error = new PiRpcCancelledError(command!);
          error.stopped = retirement;
          rejectCompact(error);
          await retirement;
        });
        const compacting = runtime.nativeCommand({
          sessionId: "a",
          command: "compact",
        });
        await compactStarted;
        let settled = false;
        void compacting.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const compactOutcome = compacting.catch((error: unknown) => error);
        const abort = runtime.abort("a");
        const abortOutcome = abort.catch((error: unknown) => error);
        await vi.waitFor(
          () => expect(worker.stop).toHaveBeenCalledWith("compact"),
          { timeout: 5_000 },
        );
        expect(settled).toBe(false);
        expect(
          events.filter((event) => event.type === "compaction_end"),
        ).toEqual([]);
        const slot = (
          runtime as unknown as { slots: Map<string, RuntimeSlot> }
        ).slots.get("a")!;
        expect(slot.stopping).not.toBeNull();
        if (outcome === "confirmed") {
          finishRetirement();
          await abort;
          await expect(compacting).resolves.toMatchObject({
            outcome: "cancelled",
          });
          expect((await runtime.snapshot()).runState).toBe("aborted");
        } else {
          const failure = new Error("Synthetic retirement was not confirmed");
          finishRetirement(failure);
          expect(await compactOutcome).toBe(failure);
          expect(await abortOutcome).toBe(failure);
          expect(
            events.filter((event) => event.type === "compaction_end"),
          ).toEqual([]);
          await expect(
            runtime.prompt({
              sessionId: "a",
              message: "must not replace an unconfirmed writer",
            }),
          ).rejects.toBe(failure);
          expect(slot.stopping).not.toBeNull();
          expect(worker.starts).toBe(1);
        }
      } finally {
        finishRetirement();
        await runtime.close();
      }
    },
  );
});
