import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }));
vi.mock("../../server/process-tree.mjs", () => ({
  isolatedProcessOptions: () => ({ detached: true }),
  signalProcessTree: boundary.signal,
}));
vi.mock("../../server/pi-runtime.js", () => ({
  piInstallation: { cliPath: "synthetic-pi" },
}));

import {
  MAX_RPC_TRACKED_REQUESTS,
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
} from "../../server/pi-rpc.js";

type Command = { id: string; type: string };
class SyntheticChild extends EventEmitter {
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Command[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const command = JSON.parse(String(chunk)) as Command;
      this.commands.push(command);
      if (this.commands.length === 1) queueMicrotask(() => this.reply(command));
      done();
    },
  });
  reply(command: Command | undefined, extra: Record<string, unknown> = {}) {
    if (!command) throw new Error("No synthetic command to reply to");
    this.frame({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      ...extra,
    });
  }
  frame(value: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  exit() {
    this.signalCode = "SIGKILL";
    this.emit("exit", null, "SIGKILL");
  }
}

let child: SyntheticChild;
let rpc: PiRpcProcess;
let diagnostics: Array<{ event: string; fields?: Record<string, unknown> }>;
beforeEach(async () => {
  vi.useFakeTimers();
  child = new SyntheticChild();
  boundary.spawn.mockReturnValue(
    child as unknown as ChildProcessWithoutNullStreams,
  );
  boundary.signal.mockReset().mockResolvedValue(undefined);
  diagnostics = [];
  rpc = new PiRpcProcess({
    cwd: "/synthetic",
    diagnostic: (_level, event, fields) => diagnostics.push({ event, fields }),
  });
  await rpc.start();
});
afterEach(async () => {
  child.exit();
  await rpc.stop();
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Pi RPC operation-owned waits", () => {
  it.each([undefined, null])(
    "waits through preflight compaction and human input with timeout %s",
    async (timeout) => {
      const outcome = vi.fn();
      const pending = rpc
        .request(
          { type: "prompt", message: "synthetic-secret-prompt" },
          timeout,
        )
        .then(outcome);
      child.frame({
        type: "compaction_start",
        summary: "synthetic-secret-summary",
      });
      await vi.advanceTimersByTimeAsync(180_001);
      expect(outcome).not.toHaveBeenCalled();
      expect(rpc.hasPendingRequest("prompt")).toBe(true);
      child.frame({
        type: "extension_ui_request",
        method: "confirm",
        id: "dialog",
        message: "synthetic-secret-dialog",
      });
      await vi.advanceTimersByTimeAsync(180_001);
      expect(outcome).not.toHaveBeenCalled();
      expect(boundary.signal).not.toHaveBeenCalled();
      await rpc.sendExtensionUiResponse({ id: "dialog", confirmed: true });
      child.reply(child.commands[1]);
      await pending;
      expect(rpc.hasPendingRequest("prompt")).toBe(false);
      expect(JSON.stringify(diagnostics)).not.toContain("synthetic-secret");
    },
  );

  it("lets explicit cancellation stop a pending preflight prompt", async () => {
    const result = rpc
      .request({ type: "prompt" }, null)
      .catch((error) => error);
    child.frame({ type: "compaction_start" });
    const stopped = rpc.stop("prompt");
    const failure = await result;
    expect(failure).toBeInstanceOf(PiRpcCancelledError);
    if (!(failure instanceof PiRpcCancelledError))
      throw new Error("Expected cancellation");
    expect(failure.stopped).not.toBeNull();
    const completed = vi.fn();
    void stopped.then(completed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    child.exit();
    await stopped;
    await failure.stopped;
  });

  it("keeps manual compaction unbounded by default", async () => {
    const result = rpc.request({ type: "compact" });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(rpc.hasPendingRequest("compact")).toBe(true);
    expect(boundary.signal).not.toHaveBeenCalled();
    child.reply(child.commands[1]);
    await result;
  });

  it("keeps default reads bounded and explicit-null reads operation owned", async () => {
    const bounded = rpc.request({ type: "get_state" }).catch((error) => error);
    const unbounded = rpc.request({ type: "get_tree" }, null);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await bounded).toMatchObject({
      message: "Pi command get_state response timed out",
    });
    expect(boundary.signal).not.toHaveBeenCalled();
    child.reply(child.commands[1]);
    child.reply(child.commands[2]);
    await unbounded;
    expect(rpc.available).toBe(true);
  });

  it("reports a bounded mutating timeout without a fictitious stopped promise", async () => {
    const fence = { received: false };
    const result = rpc
      .request({ type: "prompt" }, 20, fence)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(21);
    const failure = await result;
    expect(failure).toBeInstanceOf(PiRpcOutcomeUnknownError);
    if (!(failure instanceof PiRpcOutcomeUnknownError))
      throw new Error("Expected unknown outcome");
    expect(failure.stopped).toBeNull();
    expect(boundary.signal).not.toHaveBeenCalled();
    child.reply(child.commands[1]);
    expect(fence.received).toBe(true);
    expect(rpc.hasPendingRequest("prompt")).toBe(false);
  });

  it("caps pending plus retired identities, refuses admission, and never evicts old ids", async () => {
    const waiting = Array.from({ length: MAX_RPC_TRACKED_REQUESTS }, () =>
      rpc.request({ type: "get_state" }, 20).catch((error) => error),
    );
    await expect(rpc.request({ type: "prompt" })).rejects.toThrow(
      /capacity exhausted/,
    );
    expect(child.commands).toHaveLength(MAX_RPC_TRACKED_REQUESTS + 1);
    await vi.advanceTimersByTimeAsync(21);
    await Promise.all(waiting);
    await expect(rpc.request({ type: "prompt" })).rejects.toThrow(
      /capacity exhausted/,
    );
    // The oldest tombstone is still valid and frees one admission on receipt.
    child.reply(child.commands[1]);
    const admitted = rpc.request({ type: "get_state" });
    child.reply(child.commands.at(-1)!);
    await admitted;
    expect(rpc.available).toBe(true);
  });

  it.each([
    { command: "wrong" },
    { success: "true" },
    { id: "unknown-id" },
    { success: undefined },
  ])(
    "does not weaken malformed late-response validation: %j",
    async (extra) => {
      const result = rpc
        .request({ type: "get_state" }, 20)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(21);
      await result;
      child.reply(child.commands[1], extra);
      expect(rpc.available).toBe(false);
      expect(boundary.signal).toHaveBeenCalledWith(child, "SIGKILL", {
        isolated: true,
      });
    },
  );

  it("still rejects duplicate late responses after consuming the tombstone", async () => {
    const result = rpc
      .request({ type: "get_state" }, 20)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(21);
    await result;
    child.reply(child.commands[1]);
    expect(rpc.available).toBe(true);
    child.reply(child.commands[1]);
    expect(rpc.available).toBe(false);
  });
});

describe("Pi RPC confirmed-exit writer fence", () => {
  it("keeps startup at an explicit 60 seconds and awaits cleanup on failure", async () => {
    child.exit();
    await rpc.stop();
    child = new SyntheticChild();
    child.commands.push({ id: "skip-auto-reply", type: "synthetic" });
    boundary.spawn.mockReturnValue(child);
    boundary.signal.mockClear();
    const result = rpc.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(boundary.signal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(boundary.signal).toHaveBeenCalledWith(child, "SIGTERM", {
      isolated: true,
    });
    const finished = vi.fn();
    void result.then(finished);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).not.toHaveBeenCalled();
    child.exit();
    expect(await result).toMatchObject({
      message: "Pi command get_state response timed out",
    });
  });

  it("completes failed-spawn cleanup without requiring an impossible exit event", async () => {
    child.exit();
    await rpc.stop();
    child = new SyntheticChild();
    child.pid = undefined;
    child.commands.push({ id: "skip-auto-reply", type: "synthetic" });
    boundary.spawn.mockReturnValue(child);
    boundary.signal.mockClear();
    const result = rpc.start().catch((error: unknown) => error);
    child.emit("error", new Error("synthetic spawn failure"));
    expect(await result).toMatchObject({ message: "synthetic spawn failure" });
    await rpc.stop();
    expect(boundary.signal).not.toHaveBeenCalled();
    expect(rpc.pid).toBeNull();
  });

  it("retains the writer fence after a real stdin callback failure", async () => {
    vi.spyOn(child.stdin, "write").mockImplementationOnce(
      (...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void;
        queueMicrotask(() => callback(new Error("synthetic write failure")));
        return false;
      },
    );
    const failure = await rpc
      .request({ type: "prompt" }, null)
      .catch((error: unknown) => error);
    if (!(failure instanceof PiRpcOutcomeUnknownError) || !failure.stopped)
      throw new Error("Expected stopping unknown outcome");
    const completed = vi.fn();
    void failure.stopped.then(completed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    child.exit();
    await failure.stopped;
  });

  it("does not release on delayed/failed kills, close, error, or the old fake deadline", async () => {
    const completed = vi.fn();
    boundary.signal.mockRejectedValue(
      new Error("synthetic-secret-kill-failure"),
    );
    child.frame({
      type: "extension_ui_request",
      method: "confirm",
      message: "synthetic-secret",
    });
    const stopped = rpc.stop().then(completed);
    child.emit("error", new Error("synthetic-secret-child-error"));
    child.emit("close", null, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    expect(rpc.pid).toBe(child.pid);
    expect(rpc.available).toBe(false);
    await expect(rpc.start()).rejects.toThrow(/still stopping/);
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(
      /not available/,
    );
    await expect(rpc.sendExtensionUiResponse({ id: "x" })).rejects.toThrow(
      /not available/,
    );
    expect(diagnostics.some(({ event }) => event === "worker_stopped")).toBe(
      false,
    );
    expect(diagnostics).toContainEqual({
      event: "worker_stop_overdue",
      fields: expect.objectContaining({
        elapsedMs: 10_000,
        phase: "needs-input",
      }),
    });
    expect(JSON.stringify(diagnostics)).not.toContain("synthetic-secret");
    child.exit();
    await stopped;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("keeps unexpected protocol retirement fenced until confirmed exit", async () => {
    const result = rpc
      .request({ type: "prompt" }, null)
      .catch((error) => error);
    child.stdout.write("{malformed\n");
    const failure = await result;
    expect(failure).toBeInstanceOf(PiRpcOutcomeUnknownError);
    if (!(failure instanceof PiRpcOutcomeUnknownError) || !failure.stopped)
      throw new Error("Expected stopping unknown outcome");
    const completed = vi.fn();
    void failure.stopped.then(completed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    await expect(rpc.start()).rejects.toThrow(/still stopping/);
    child.exit();
    await failure.stopped;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("awaits slow process-tree operations even after observing the leader exit", async () => {
    let finishTree!: () => void;
    boundary.signal.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTree = resolve;
        }),
    );
    // Unexpected exit needs one hard tree operation, which models slow taskkill.
    child.exit();
    const completed = vi.fn();
    const stopped = rpc.stop().then(completed);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(completed).not.toHaveBeenCalled();
    await expect(rpc.start()).rejects.toThrow(/still stopping/);
    finishTree();
    await stopped;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("awaits both graceful and hard tree signaling without extending the escalation deadline", async () => {
    const finishes: Array<() => void> = [];
    boundary.signal.mockImplementation(
      () => new Promise<void>((resolve) => finishes.push(resolve)),
    );
    const completed = vi.fn();
    const stopped = rpc.stop().then(completed);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(boundary.signal.mock.calls.map((call) => call[1])).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    child.exit();
    finishes[1]!();
    await flush();
    expect(completed).not.toHaveBeenCalled();
    finishes[0]!();
    await stopped;
  });

  it("allows restart only after the old writer is confirmed gone", async () => {
    const stopped = rpc.stop();
    child.exit();
    await stopped;
    child = new SyntheticChild();
    boundary.spawn.mockReturnValue(child);
    await rpc.start();
    expect(rpc.available).toBe(true);
  });
});
