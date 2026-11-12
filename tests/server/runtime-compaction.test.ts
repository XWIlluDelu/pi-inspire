import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpcCancelledError } from "../../server/pi-rpc.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("RuntimeController compaction lifecycle", () => {
  it("keeps an unresponsive compaction fenced until writer retirement is confirmed", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    const compactStarted = deferredSignal();
    let finishRetirement!: (error?: Error) => void;
    const retirement = new Promise<void>((resolve, reject) => {
      finishRetirement = (error) => (error ? reject(error) : resolve());
    });
    const failure = new Error("Synthetic retirement was not confirmed");
    const compactionEnd = vi.fn();
    runtime.on("event", (event) => {
      if (event.type === "compaction_end") compactionEnd(event);
    });
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const { worker } = f;
      let rejectCompact!: (error: Error) => void;
      worker.responseOverrides.set("compact", () => {
        compactStarted.resolve();
        return new Promise<never>((_resolve, reject) => {
          rejectCompact = reject;
        });
      });
      const stop = vi
        .spyOn(worker, "stop")
        .mockImplementation(async (command) => {
          const error = new PiRpcCancelledError(command!);
          error.stopped = retirement;
          rejectCompact(error);
          await retirement;
        });
      const result = runtime.nativeCommand({
        sessionId: "a",
        command: "compact",
      });
      const settled = vi.fn();
      void result.then(settled, settled);
      const compactOutcome = expect(result).rejects.toBe(failure);
      await compactStarted.promise;
      const abortOutcome = expect(runtime.abort("a")).rejects.toBe(failure);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith("compact"), {
        timeout: 5_000,
      });
      expect(settled).not.toHaveBeenCalled();
      expect(compactionEnd).not.toHaveBeenCalled();

      finishRetirement(failure);
      await Promise.all([compactOutcome, abortOutcome]);
      expect(compactionEnd).not.toHaveBeenCalled();
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "must not replace an unconfirmed writer",
        }),
      ).rejects.toBe(failure);
      expect(f.workers).toHaveLength(1);
    } finally {
      finishRetirement();
      await expect(runtime.close()).rejects.toBe(failure);
    }
  });
});
