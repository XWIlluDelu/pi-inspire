import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PiRpcProcess } from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  preview,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("native commands and worker-local catalogs", () => {
  it("rejects built-in name collisions at the ordinary RPC prompt boundary", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({
      attachments: store,
      configure: (worker) => {
        worker.responseOverrides.set("get_commands", {
          commands: [
            {
              name: "model",
              description: "Extension-owned model command",
              source: "extension",
            },
            { name: "plugin:model", source: "extension" },
            { name: "CamelCase", source: "extension" },
          ],
        });
      },
    });
    const { runtime } = f;

    await runtime.openSession("a");
    await vi.waitFor(() => expect(f.worker.starts).toBe(1));
    await runtime.snapshot();
    expect(
      f.worker.commands.some((command) => command.type === "get_commands"),
    ).toBe(true);
    await expect(
      runtime.prompt({ sessionId: "a", message: "/model custom" }),
    ).rejects.toThrow("native command surface");
    expect(f.worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );
    await runtime.prompt({ sessionId: "a", message: "/plugin:model custom" });
    expect(f.worker.commands).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        message: "/plugin:model custom",
      }),
    );
    await runtime.close();
  });

  it("publishes resource-command completion without settling active model work", async () => {
    const f = schedulingRuntime({
      configure: (worker) => {
        worker.responseOverrides.set("get_commands", {
          commands: [{ name: "reload-fixture", source: "extension" }],
        });
      },
    });
    const { runtime } = f;
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    try {
      await runtime.openSession("a");
      await runtime.setAutoRetry("a", false);
      f.worker.emit("event", { type: "agent_start" });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "agent_start")).toBe(true),
      );
      await runtime.prompt({ sessionId: "a", message: "/reload-fixture" });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "prompt_finished",
          sessionStatus: expect.objectContaining({ runState: "running" }),
        }),
      );
      expect((await runtime.snapshot("a")).runState).toBe("running");
      expect(f.worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("revalidates command ownership after a queued worker reload", async () => {
    const workers: FakeRpc[] = [];
    const gate = deferredSignal();
    const started = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        worker.responseOverrides.set("get_commands", {
          commands:
            workers.length === 0
              ? [{ name: "old-command", source: "extension" }]
              : [],
        });
        worker.responseOverrides.set("export_html", () => {
          started.resolve();
          return gate.promise.then(() => ({ path: "/tmp/export.html" }));
        });
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
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
      await reloading;
      await rejected;
      expect(workers).toHaveLength(2);
      expect(
        workers[1]!.commands.some((command) => command.type === "prompt"),
      ).toBe(false);
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("exports HTML and reloads a fresh Pi resource inventory", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        const generation = workers.length + 1;
        worker.responseOverrides.set("export_html", {
          path: resolve(`/tmp/session-${generation}.html`),
        });
        worker.responseOverrides.set("get_commands", {
          commands: [
            {
              name: `generation-${generation}`,
              description: "Resource generation",
              source: "extension",
            },
          ],
        });
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await vi.waitFor(() => expect(workers[0]?.starts).toBe(1));
    expect((await runtime.snapshot()).active?.commands).toEqual([
      expect.objectContaining({ name: "generation-1" }),
    ]);
    workers[0]!.emit("event", { type: "agent_start" });
    expect((await runtime.snapshot("a")).runState).toBe("running");
    await expect(
      runtime.nativeCommand({
        sessionId: "a",
        command: "export",
        argument: "/tmp/export.html",
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      details: [{ label: "File", value: resolve("/tmp/session-1.html") }],
    });
    expect((await runtime.snapshot("a")).runState).toBe("running");
    expect(workers[0]!.stops).toBe(0);

    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot("a")).runState).toBe("idle"),
    );
    await expect(
      runtime.nativeCommand({ sessionId: "a", command: "reload" }),
    ).resolves.toMatchObject({ command: "reload", outcome: "completed" });
    expect(workers[0]?.stops).toBe(1);
    expect(workers[1]?.starts).toBe(1);
    expect((await runtime.snapshot()).active?.commands).toEqual([
      expect.objectContaining({ name: "generation-2" }),
    ]);
    await runtime.close();
  });

  it("routes a typed /compact to the RPC compact command instead of prompting", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;

    await runtime.openSession("a");
    await runtime.prompt({
      sessionId: "a",
      message: "/compact focus on the parser work",
    });
    expect(
      f.worker.commands.find((command) => command.type === "compact"),
    ).toMatchObject({
      customInstructions: "focus on the parser work",
    });
    expect(f.worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );

    const result = await runtime.nativeCommand({
      sessionId: "a",
      command: "compact",
      argument: "keep decisions",
    });
    expect(result).toMatchObject({
      command: "compact",
      outcome: "completed",
    });
    expect(
      f.worker.commands.filter((command) => command.type === "compact").at(-1),
    ).toMatchObject({ customInstructions: "keep decisions" });

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "/compaction strategies?",
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Slash syntax elsewhere in conversational text remains ordinary input.
    await runtime.prompt({
      sessionId: "a",
      message: "Discuss /compaction strategies?",
    });
    expect(
      f.worker.commands.filter((command) => command.type === "prompt"),
    ).toEqual([{ type: "prompt", message: "Discuss /compaction strategies?" }]);
    await runtime.close();
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
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const before = await runtime.snapshot();
      const { promise, resolve: release } = deferredSignal();
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
      await runtime.close();
    }
  });
});
