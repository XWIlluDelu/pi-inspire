import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcProcess, PiRpcResponseFence } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { RuntimeBashController } from "../../server/runtime-bash.js";
import {
  createRuntimeSlot,
  type RuntimeSlot,
} from "../../server/runtime-slot.js";
import {
  catalog,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  preview,
  record,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

function fixture() {
  const slot = createRuntimeSlot({
    id: "shell",
    cwd: "/synthetic",
    sessionPath: null,
    process: null,
    preview: null,
    projection: null,
    bridge: null,
    branchRevision: 0,
    incarnationId: "shell-slot",
    viewId: "shell-view",
  });
  const worker = {} as PiRpcProcess;
  slot.process = worker;
  slot.ready = true;
  let finish!: (value: Record<string, unknown>) => void;
  const result = new Promise<Record<string, unknown>>((resolve) => {
    finish = resolve;
  });
  const host = {
    admit: vi.fn(async () => worker),
    request: vi.fn(
      async (
        _slot: RuntimeSlot,
        _worker: PiRpcProcess,
        _command: Record<string, unknown>,
        fence: PiRpcResponseFence,
      ) => {
        fence.id = "owned-shell";
        return result;
      },
    ),
    updateOverlay: vi.fn((_slot: RuntimeSlot, message: unknown) => message),
    emit: vi.fn((_slot: RuntimeSlot, _event: unknown) => {}),
    reconcile: vi.fn(async () => {}),
  };
  return { slot, host, finish, bash: new RuntimeBashController(host) };
}

describe("RuntimeController shell acceptance", () => {
  beforeEach(initializeRuntimeFixture);
  afterEach(disposeRuntimeFixture);

  it("consumes a confirmed shell command even when reconciliation and worker retirement fail", async () => {
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
      const reconcile = vi.spyOn(
        runtime as unknown as { reconcileSlot(): Promise<unknown> },
        "reconcileSlot",
      );
      worker.responseOverrides.set("bash", () => {
        reconcile.mockRejectedValueOnce(new Error("Projection unavailable"));
        worker.stop = async () => {
          worker.stops += 1;
          throw new Error("Worker exit could not be confirmed");
        };
        return {
          output: "done",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        };
      });
      await expect(
        runtime.prompt({ sessionId: "a", message: "!echo done" }),
      ).resolves.toEqual({ text: "!echo done", images: [], files: [] });
      expect((await runtime.snapshot()).runState).toBe("conflict");
      await expect(
        runtime.prompt({ sessionId: "a", message: "!echo done" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        worker.commands.filter((command) => command.type === "bash"),
      ).toHaveLength(1);
      expect(worker.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });
});

describe("native Bash boundary", () => {
  it("rejects empty prefixes before starting a worker", async () => {
    const f = fixture();
    await expect(f.bash.execute(f.slot, "!")).rejects.toThrow(
      /Enter a command/,
    );
    await expect(f.bash.execute(f.slot, "!! ")).rejects.toThrow(
      /Enter a command/,
    );
    expect(f.host.admit).not.toHaveBeenCalled();
  });

  it("owns only its request-id deltas, bounds the live tail and uses the exact native final result", async () => {
    const f = fixture();
    f.slot.runState = "running";
    const execution = f.bash.execute(f.slot, "!!echo exact");
    await vi.waitFor(() => expect(f.host.request).toHaveBeenCalled());
    expect(f.host.request.mock.calls[0]![2]).toEqual({
      type: "bash",
      command: "echo exact",
      excludeFromContext: true,
    });
    expect(
      f.bash.update(f.slot, { id: "another-request", delta: "NOT_OURS" }),
    ).toBe(false);
    expect(f.bash.update(f.slot, { delta: "UNTAGGED" })).toBe(false);
    expect(
      f.bash.update(f.slot, { id: "owned-shell", delta: "x".repeat(60_000) }),
    ).toBe(true);
    expect(f.slot.nativeBash!.message.output).toHaveLength(50_000);
    expect(f.slot.nativeBash!.message.__inspireBashPreviewTruncated).toBe(true);
    await expect(f.bash.execute(f.slot, "!pwd")).rejects.toThrow(
      /already running/,
    );
    f.finish({
      output: "EXACT_FINAL",
      exitCode: 9,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/synthetic/full.txt",
    });
    await expect(execution).resolves.toEqual({
      text: "!!echo exact",
      images: [],
      files: [],
    });
    expect(
      f.host.emit.mock.calls.some(([_slot, event]) => {
        const record = event as {
          type: string;
          message?: Record<string, unknown>;
        };
        return (
          record.type === "message_end" &&
          record.message?.output === "EXACT_FINAL"
        );
      }),
    ).toBe(true);
    expect(f.slot.nativeBash).toBeNull();
    expect(f.slot.runState).toBe("running");
    expect(f.bash.update(f.slot, { id: "owned-shell", delta: "LATE" })).toBe(
      false,
    );
  });

  it("retirement settles only the owned transient shell without fabricating native metadata", async () => {
    const f = fixture();
    const pending = f.bash.execute(f.slot, "!echo partial");
    await vi.waitFor(() => expect(f.host.request).toHaveBeenCalled());
    f.bash.update(f.slot, { id: "owned-shell", delta: "known partial output" });
    f.bash.retire(f.slot, {} as PiRpcProcess);
    expect(f.slot.nativeBash!.message.__inspireBashRunning).toBe(true);
    f.bash.retire(f.slot, f.slot.process!);
    expect(f.slot.nativeBash!.message).toMatchObject({
      output: "known partial output",
      __inspireBashRunning: false,
      __inspireBashInterrupted: true,
    });
    expect(f.slot.nativeBash!.message.cancelled).toBeUndefined();
    expect(f.slot.nativeBash!.message.exitCode).toBeUndefined();
    expect(f.bash.update(f.slot, { id: "owned-shell", delta: "LATE" })).toBe(
      false,
    );
    f.slot.process = null;
    f.slot.nativeBash = null;
    f.finish({ output: "unconfirmed" });
    await expect(pending).rejects.toThrow(/worker stopped/);
    expect(f.host.reconcile).not.toHaveBeenCalled();
  });
});
