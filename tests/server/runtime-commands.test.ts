import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";

import {
  deferredSignal,
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("native commands and worker-local catalogs", () => {
  it("routes native and extension commands without settling active model work", async () => {
    const fixture = schedulingRuntime({
      configure: (worker) => {
        worker.responseOverrides.set("get_commands", {
          commands: [
            { name: "model", source: "extension" },
            { name: "plugin:model", source: "extension" },
          ],
        });
        worker.responseOverrides.set("export_html", {
          path: resolve("/tmp/session.html"),
        });
      },
    });
    const { runtime } = fixture;
    const finished = vi.fn();
    runtime.on("event", (event) => {
      if (event.type === "prompt_finished") finished(event);
    });
    trackRuntime(runtime);
    const prompt = (message: string) =>
      runtime.prompt({ sessionId: "a", message });
    await runtime.openSession("a");
    await waitForReady(runtime, "a");

    await expect(prompt("/model custom")).rejects.toThrow(
      "native command surface",
    );
    await expect(prompt("/compaction strategies?")).rejects.toMatchObject({
      status: 409,
    });
    await prompt("/compact focus on the parser work");
    await expect(
      runtime.nativeCommand({
        sessionId: "a",
        command: "compact",
        argument: "keep decisions",
      }),
    ).resolves.toMatchObject({ command: "compact", outcome: "completed" });
    expect(
      fixture.worker.commands.filter(({ type }) => type === "compact"),
    ).toEqual([
      expect.objectContaining({
        customInstructions: "focus on the parser work",
      }),
      expect.objectContaining({ customInstructions: "keep decisions" }),
    ]);

    await prompt("Discuss /compaction strategies?");
    fixture.worker.emit("event", { type: "agent_start" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot("a")).runState).toBe("running"),
    );
    await prompt("/plugin:model custom");
    expect(finished).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionStatus: expect.objectContaining({ runState: "running" }),
      }),
    );
    expect(
      fixture.worker.commands.filter(({ type }) => type === "prompt"),
    ).toEqual([
      expect.objectContaining({ message: "Discuss /compaction strategies?" }),
      expect.objectContaining({ message: "/plugin:model custom" }),
    ]);
    await expect(
      runtime.nativeCommand({
        sessionId: "a",
        command: "export",
        argument: "/tmp/export.html",
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      details: [{ label: "File", value: resolve("/tmp/session.html") }],
    });
    expect((await runtime.snapshot("a")).runState).toBe("running");
    expect(fixture.worker.stops).toBe(0);
  });

  it("revalidates command ownership after a queued worker reload", async () => {
    const gate = deferredSignal();
    const started = deferredSignal();
    const { runtime, workers } = schedulingRuntime({
      configure: (worker) => {
        worker.responseOverrides.set("get_commands", {
          commands: [
            {
              name: workers.length === 0 ? "old-command" : "new-command",
              source: "extension",
            },
          ],
        });
        worker.responseOverrides.set("export_html", () => {
          started.resolve();
          return gate.promise.then(() => ({ path: "/tmp/export.html" }));
        });
      },
    });
    try {
      await runtime.openSession("a");
      await runtime.setAutoRetry("a", true);
      expect((await runtime.snapshot("a")).active?.commands).toEqual([
        expect.objectContaining({ name: "old-command" }),
      ]);
      const exporting = runtime.nativeCommand({
        sessionId: "a",
        command: "export",
      });
      await started.promise;
      const reloading = runtime.nativeCommand({
        sessionId: "a",
        command: "reload",
      });
      const prompting = runtime.prompt({
        sessionId: "a",
        message: "/old-command",
      });
      // Attach the rejection observer before releasing the serialized writer.
      const rejected = expect(prompting).rejects.toThrow("no longer available");
      gate.resolve();
      await exporting;
      await expect(reloading).resolves.toMatchObject({
        command: "reload",
        outcome: "completed",
      });
      await rejected;
      expect(workers).toHaveLength(2);
      expect(workers[0]?.stops).toBe(1);
      expect((await runtime.snapshot("a")).active?.commands).toEqual([
        expect.objectContaining({ name: "new-command" }),
      ]);
      expect(
        workers[1]!.commands.some((command) => command.type === "prompt"),
      ).toBe(false);
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("coalesces same-worker reads, updates its cache, and hides internal command/status traffic", async () => {
    const f = schedulingRuntime({
      configure: (worker) => {
        worker.responseOverrides.set("get_available_models", {
          models: [{ provider: "test", id: "cached", reasoning: true }],
        });
        worker.responseOverrides.set("get_commands", {
          commands: [
            {
              name: `${worker.options.env!.INSPIRE_BRANCH_COMMAND}${MODEL_REFRESH_SUFFIX}`,
              source: "extension",
            },
            { name: "user-extension", source: "extension" },
          ],
        });
      },
    });
    const { runtime } = f;
    trackRuntime(runtime);
    const { promise, resolve: release } = deferredSignal();
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const before = await runtime.snapshot();
      f.worker.responseOverrides.set(
        "prompt",
        async (command: Record<string, unknown>) => {
          await promise;
          const encoded = String(command.message).split(" ")[1]!;
          const request = decodeBranchBridgeJson(encoded, 4096) as object;
          f.worker.emit("event", {
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: `${f.worker.options.env!.INSPIRE_BRANCH_STATUS_KEY}${MODEL_REFRESH_SUFFIX}`,
            statusText: encodeBranchBridgeJson({ ...request, ok: true }, 2048),
          });
          f.worker.responseOverrides.set("get_available_models", {
            models: [
              {
                provider: "test",
                id: "fresh",
                reasoning: true,
                thinkingLevelMap: { max: "max" },
              },
            ],
          });
          return {};
        },
      );
      const first = runtime.refreshModels("a");
      const second = runtime.refreshModels("a");
      await vi.waitFor(() =>
        expect(
          f.worker.commands.filter((command) => command.type === "prompt"),
        ).toHaveLength(1),
      );
      release();
      expect(await first).toEqual(await second);
      const after = await runtime.snapshot();
      expect(after.active?.availableModels).toEqual([
        {
          provider: "test",
          id: "fresh",
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        },
      ]);
      expect(after.active?.model).toEqual(before.active?.model);
      expect(after.active?.thinkingLevel).toBe(before.active?.thinkingLevel);
      expect(after.active?.commands).toEqual([
        { name: "user-extension", source: "extension" },
      ]);
      expect(after.extensionStatuses ?? {}).toEqual({});
      expect(f.worker.stops).toBe(0);
      expect(f.worker.starts).toBe(1);
    } finally {
      release();
    }
  });
});
