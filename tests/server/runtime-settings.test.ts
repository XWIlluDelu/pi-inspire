import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  FakeRpc,
  record,
  waitForReady,
  preview,
  catalog,
  trackedAttachmentStore,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("RuntimeController settings and retry observation", () => {
  it("routes setting updates to their native RPC commands", async () => {
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
    try {
      await runtime.openSession("a");
      await runtime.setAutoCompaction("a", false);
      await runtime.setAutoRetry("a", true);
      await runtime.setSteeringMode("a", "one-at-a-time");
      await runtime.setFollowUpMode("a", "all");
      expect(worker.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "set_auto_compaction",
            enabled: false,
          }),
          expect.objectContaining({ type: "set_auto_retry", enabled: true }),
          expect.objectContaining({
            type: "set_steering_mode",
            mode: "one-at-a-time",
          }),
          expect.objectContaining({ type: "set_follow_up_mode", mode: "all" }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not substitute submitted retry intent when native confirmation is unavailable", async () => {
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
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      expect(
        (await runtime.snapshot("a")).active?.runtimeSettings?.autoRetryEnabled,
      ).toBe(true);
      const reads = worker.retryReads;
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_update" });
      expect(worker.retryReads).toBe(reads);
      worker.confirmRetryState = false;
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
      // Ensure the worker exists without requiring the observer to send a prompt.
      await runtime.setAutoRetry("a", true);
      worker.emit("event", {
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

      worker.emit("event", { type: "auto_retry_end", success: true });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "auto_retry_end")).toBe(
          true,
        ),
      );
      expect((await runtime.snapshot("a")).retry).toBeNull();
      worker.emit("event", {
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
      worker.emit("event", { type: "agent_settled" });
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
