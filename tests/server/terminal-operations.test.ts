import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { TerminalOperationReceipts } from "../../server/terminal-operation-receipts.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";
import type { TerminalDescriptor } from "../../shared/terminal-contracts.js";
import type { TerminalOperation } from "../../shared/terminal-operations.js";
import { terminalDaemonFixture } from "./fixtures/terminal-daemon.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("terminal control receipts over isolated IPC", () => {
  it("replays a lost receipt through a replacement Host and retires it when the daemon changes", async () => {
    const f = await terminalDaemonFixture();
    const host = f.connect();
    const committed = deferred<void>();
    const reply = deferred<TerminalDescriptor>();
    const result = {
      id: "synthetic-terminal",
      catalogEpoch: "catalog",
      catalogRevision: 1,
    } as TerminalDescriptor;
    const mutation = vi
      .spyOn(f.manager, "create")
      .mockImplementation(async () => {
        committed.resolve();
        return reply.promise;
      });
    const operation = createIntent(
      await f.client.operationEpoch(),
      f.directory,
    );
    let daemon: TerminalDaemonServer | undefined;
    try {
      vi.useFakeTimers();
      const first = f.client
        .operate(operation)
        .catch((error: unknown) => error);
      await committed.promise;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await first).toMatchObject({ code: "terminal_daemon_timeout" });
      vi.useRealTimers();
      // Neither closing the old Host connection nor two simultaneous delivery
      // attempts may dispatch the daemon mutation again.
      await f.client.close();
      const second = host.operate(operation, true);
      const concurrent = host.operate(
        {
          ...operation,
          intent: {
            command: "create",
            params: { request: { cols: 90, cwd: f.directory } },
          },
        },
        true,
      );
      reply.resolve(result);
      expect(await second).toEqual(result);
      expect(await concurrent).toEqual(result);
      expect(await host.operate(operation, true)).toEqual(result);
      expect(mutation).toHaveBeenCalledOnce();

      await f.server.stop();
      const replacementManager = new TerminalSessionManager();
      const create = vi.spyOn(replacementManager, "create");
      daemon = new TerminalDaemonServer(
        f.address,
        f.secret,
        replacementManager,
      );
      await daemon.start();
      await expect(host.operate(operation, true)).rejects.toMatchObject({
        code: "terminal_operation_epoch_changed",
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      reply.resolve(result);
      await host.close();
      await daemon?.stop();
      await f.close();
    }
  });
});

function createIntent(epoch: string, cwd = "/fixture") {
  return {
    executor: { kind: "terminal", epoch },
    operationId: randomUUID(),
    intent: { command: "create", params: { request: { cwd, cols: 90 } } },
  } as const satisfies TerminalOperation;
}

describe("bounded terminal receipts", () => {
  it("snapshots results and tombstones byte-budget evictions without replaying work", async () => {
    const receipts = new TerminalOperationReceipts();
    const first = createIntent(receipts.getEpoch());
    const source = { id: "original", payload: "x".repeat(255 * 1024) };
    const execute = vi.fn(async () => source);
    await receipts.run(first, execute);
    source.id = "changed";
    expect(await receipts.run(first)).toMatchObject({
      id: "original",
    });
    for (let index = 0; index < 66; index++)
      await receipts.run(
        { ...first, operationId: randomUUID() },
        async () => source,
      );
    await expect(receipts.run(first)).rejects.toMatchObject({
      code: "terminal_operation_expired",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves in-flight work at capacity, tombstones expired results and fences forgotten identities", async () => {
    let now = 0;
    const receipts = new TerminalOperationReceipts({
      now: () => now,
      resultTtlMs: 10,
      tombstoneTtlMs: 20,
      limit: 1,
    });
    const operation = createIntent(receipts.getEpoch());
    const gate = deferred<{ id: string }>();
    const execute = vi.fn(() => gate.promise);
    const observe = () => receipts.run(operation);
    await expect(observe()).rejects.toMatchObject({
      code: "terminal_operation_missing",
    });
    expect(execute).not.toHaveBeenCalled();
    const first = receipts.run(operation, execute);
    await expect(
      receipts.run({ ...operation, operationId: randomUUID() }, execute),
    ).rejects.toMatchObject({ code: "terminal_operation_capacity" });
    const duplicate = observe();
    const result = { id: "one" };
    gate.resolve(result);
    expect(await Promise.all([first, duplicate])).toEqual([result, result]);
    now = 10;
    await expect(observe()).rejects.toMatchObject({
      code: "terminal_operation_expired",
    });
    now = 20;
    await expect(observe()).rejects.toMatchObject({
      code: "terminal_operation_epoch_changed",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
