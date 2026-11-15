import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
  startWorker,
  trackRuntime,
} from "./fixtures/runtime.js";

describe("worker-confirmed retry observation", () => {
  beforeEach(initializeRuntimeFixture);
  afterEach(disposeRuntimeFixture);

  it("does not substitute submitted retry intent when native confirmation is unavailable", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime);
    await runtime.setRuntimeSetting("a", {
      key: "autoRetryEnabled",
      value: false,
    });
    expect(
      (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
    ).toBe(false);
    f.worker.confirmRetryState = false;
    await expect(
      runtime.setRuntimeSetting("a", { key: "autoRetryEnabled", value: true }),
    ).rejects.toThrow("Pi did not confirm effective retry state");
    expect(
      (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
    ).toBeNull();
    expect((await runtime.snapshot("a")).extensionStatuses).toEqual({});
  });

  it("bounds retry detail for late observers and clears it at the owning phase boundary", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    const events = new Map<string, Record<string, unknown>>();
    runtime.on("event", (event) => events.set(event.type, event));
    const emit = async (type: string, fields: Record<string, unknown> = {}) => {
      events.delete(type);
      f.worker.emit("event", { type, ...fields });
      await vi.waitFor(() => expect(events.has(type), type).toBe(true));
      return events.get(type)!;
    };
    const snapshot = () => runtime.snapshot("a");
    const detail = { attempt: 2, maxAttempts: 3, message: "x".repeat(4000) };
    const retry = {
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "x".repeat(5000),
    };
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime);
    expect(await emit("auto_retry_start", retry)).toMatchObject({
      retry: detail,
    });
    expect(await snapshot()).toMatchObject({
      sessionStatuses: { a: { runState: "retrying" } },
      retry: detail,
    });
    expect(await emit("auto_retry_end", { success: true })).toMatchObject({
      retry: null,
    });
    expect((await snapshot()).retry).toBeNull();
    await emit("auto_retry_start", { ...retry, attempt: 99 });
    expect(await snapshot()).toMatchObject({
      sessionStatuses: { a: { runState: "retrying" } },
      retry: null,
    });
    await emit("agent_settled");
    expect(await snapshot()).toMatchObject({
      sessionStatuses: { a: { runState: "idle" } },
      retry: null,
    });

    await emit("compaction_start", { reason: "manual" });
    expect(await emit("summarization_retry_scheduled", retry)).toMatchObject({
      summarizationRetry: detail,
    });
    expect(await snapshot()).toMatchObject({
      sessionStatuses: { a: { runState: "compacting" } },
      retry: null,
      summarizationRetry: detail,
    });
    for (const type of [
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
    ]) {
      expect(await emit(type)).toMatchObject({
        sessionStatus: { runState: "compacting" },
        summarizationRetry: null,
      });
      await emit("summarization_retry_scheduled", retry);
    }
    await emit("compaction_end", { reason: "manual", aborted: true });
    expect(await snapshot()).toMatchObject({
      sessionStatuses: { a: { runState: "aborted" } },
      summarizationRetry: null,
    });
  });
});
