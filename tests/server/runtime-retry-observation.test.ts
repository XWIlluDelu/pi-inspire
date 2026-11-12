import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { readWorkerRetryState } from "../../server/runtime-retry-state.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  RETRY_STATE_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";
import {
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

describe("worker-confirmed retry observation", () => {
  beforeEach(initializeRuntimeFixture);
  afterEach(disposeRuntimeFixture);

  it("does not substitute submitted retry intent when native confirmation is unavailable", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    await runtime.setAutoRetry("a", false);
    expect(
      (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
    ).toBe(false);
    f.worker.confirmRetryState = false;
    await expect(runtime.setAutoRetry("a", true)).rejects.toThrow(
      "Pi did not confirm effective retry state",
    );
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
    await waitForReady(runtime);
    expect((await emit("auto_retry_start", retry)).errorMessage).toBe(
      detail.message,
    );
    expect(await snapshot()).toMatchObject({
      runState: "retrying",
      retry: detail,
    });
    await emit("auto_retry_end", { success: true });
    expect((await snapshot()).retry).toBeNull();
    await emit("auto_retry_start", { ...retry, attempt: 99 });
    expect(await snapshot()).toMatchObject({
      runState: "retrying",
      retry: null,
    });
    await emit("agent_settled");
    expect(await snapshot()).toMatchObject({ runState: "idle", retry: null });

    await emit("compaction_start", { reason: "manual" });
    expect(
      (await emit("summarization_retry_scheduled", retry)).errorMessage,
    ).toBe(detail.message);
    expect(await snapshot()).toMatchObject({
      runState: "compacting",
      retry: null,
      summarizationRetry: detail,
    });
    expect((await snapshot()).summarizationRetry).toEqual(detail);
    for (const type of [
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
    ]) {
      await emit(type);
      expect(await snapshot()).toMatchObject({
        runState: "compacting",
        summarizationRetry: null,
      });
      await emit("summarization_retry_scheduled", retry);
    }
    await emit("compaction_end", { reason: "manual", aborted: true });
    expect(await snapshot()).toMatchObject({
      runState: "aborted",
      summarizationRetry: null,
    });
  });
});

describe("worker retry confirmation", () => {
  it.each([
    { failure: "non-boolean", values: ["true"] },
    { failure: "duplicate", values: [true, false] },
  ])("rejects a $failure confirmation", async ({ values }) => {
    const bridge = {
      command: "command",
      statusKey: "status",
      workerId: "worker",
    };
    const events = new EventEmitter();
    const rpc = Object.assign(events, {
      async request(command: Record<string, unknown>) {
        const argument = String(command.message).split(" ")[1];
        const owner = decodeBranchBridgeJson(argument, 4_096) as object;
        for (const autoRetryEnabled of values)
          events.emit("event", {
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: `${bridge.statusKey}${RETRY_STATE_SUFFIX}`,
            statusText: encodeBranchBridgeJson(
              { ...owner, autoRetryEnabled },
              2_048,
            ),
          });
        return { disposition: "handled" };
      },
    }) as unknown as PiRpcProcess;
    await expect(readWorkerRetryState(rpc, bridge, "session")).rejects.toThrow(
      "Malformed retry state result",
    );
  });
});
