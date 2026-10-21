import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  waitForReady,
  schedulingRuntime,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker-confirmed retry observation", () => {
  it("does not substitute submitted retry intent when native confirmation is unavailable", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      expect(
        (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
      ).toBe(true);
      const reads = f.worker.retryReads;
      f.worker.emit("event", { type: "agent_start" });
      f.worker.emit("event", { type: "message_update" });
      expect(f.worker.retryReads).toBe(reads);
      f.worker.confirmRetryState = false;
      await expect(runtime.setAutoRetry("a", false)).rejects.toThrow(
        "Pi did not confirm effective retry state",
      );
      expect(
        (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
      ).toBeNull();
      expect((await runtime.snapshot("a")).extensionStatuses).toEqual({});
    } finally {
      await runtime.close();
    }
  });

  it("snapshots bounded retry detail for late observers and retires it with the phase", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    try {
      await runtime.openSession("a");
      // Ensure the worker exists without requiring the observer to send a prompt.
      await runtime.setAutoRetry("a", true);
      f.worker.emit("event", {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        errorMessage: "x".repeat(5000),
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "auto_retry_start")).toBe(
          true,
        ),
      );
      expect(
        events.find((event) => event.type === "auto_retry_start")?.errorMessage,
      ).toHaveLength(4000);
      const joined = await runtime.snapshot("a");
      expect(joined.runState).toBe("retrying");
      expect(joined.retry).toEqual({
        attempt: 2,
        maxAttempts: 3,
        message: "x".repeat(4000),
      });
      expect((await runtime.snapshot("a")).retry).toEqual(joined.retry);

      f.worker.emit("event", { type: "auto_retry_end", success: true });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "auto_retry_end")).toBe(
          true,
        ),
      );
      expect((await runtime.snapshot("a")).retry).toBeNull();
      f.worker.emit("event", {
        type: "auto_retry_start",
        attempt: 99,
        maxAttempts: 3,
        errorMessage: "invalid attempt",
      });
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      expect(await runtime.snapshot("a")).toMatchObject({
        runState: "retrying",
        retry: null,
      });
      f.worker.emit("event", { type: "agent_settled" });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "agent_settled")).toBe(
          true,
        ),
      );
      expect(await runtime.snapshot("a")).toMatchObject({
        runState: "idle",
        retry: null,
      });
    } finally {
      await runtime.close();
    }
  });
});
