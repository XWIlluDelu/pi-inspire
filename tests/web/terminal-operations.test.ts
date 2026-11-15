// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { TerminalOperation } from "../../shared/terminal-operations";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";

const oldEpoch = "11111111-1111-4111-8111-111111111111";
const newEpoch = "22222222-2222-4222-8222-222222222222";
const key = "inspire:terminal-operations:v2";
const create = {
  command: "create",
  params: { request: { cwd: "/fixture" } },
} as const;
const remove = {
  command: "remove",
  params: { id: "terminal", force: true },
} as const;

function transport(
  handle: (operation: TerminalOperation) => Promise<Response> | Response,
  epoch = oldEpoch,
) {
  return vi.fn<typeof fetch>(async (_path, init) =>
    init?.method === "POST"
      ? handle(JSON.parse(String(init.body)))
      : Response.json({ epoch }),
  );
}

function reply(
  operation: TerminalOperation,
  patch: Record<string, unknown> = {},
  status = 200,
) {
  return Response.json(
    {
      executor: operation.executor,
      command: operation.intent.command,
      operationId: operation.operationId,
      state: "completed",
      result: { id: "terminal" },
      ...patch,
    },
    { status },
  );
}

beforeEach(() => sessionStorage.clear());

it("preserves the original intent across a mismatched receipt, reload, and daemon replacement", async () => {
  const handle = vi.fn(reply)
    .mockImplementationOnce((operation) =>
      reply(operation, { executor: { kind: "terminal", epoch: newEpoch } }),
    )
    .mockImplementationOnce((operation) =>
      reply(operation, {
        state: "unknown",
        error: { message: "Receipt expired", status: 409 },
      }, 409),
    )
    .mockImplementationOnce((operation) => reply(operation, { result: null }));
  await expect(
    new TerminalOperationController(transport(handle)).run(remove),
  ).rejects.toThrow("outcome is unknown");
  const request = transport(handle, newEpoch);
  const restarted = new TerminalOperationController(request);
  restarted.restore();
  const [entry] = restarted.snapshot();
  expect(entry?.outcome).toBe("unknown");
  await expect(restarted.retry(entry!.key)).rejects.toThrow("Receipt expired");
  expect(request.mock.calls[0]?.[0]).toBe("/api/terminal-operations?observe=1");
  const intent = handle.mock.calls[0]![0];
  expect(handle.mock.calls[1]![0]).toEqual(intent);
  restarted.stopTracking(entry!.key);
  await expect(restarted.run(remove)).resolves.toBeNull();
  expect(handle.mock.calls[2]![0]).toMatchObject({
    executor: { epoch: newEpoch },
    intent: remove,
  });
  expect(handle.mock.calls[2]![0].operationId).not.toBe(intent.operationId);
});

it("releases a matched refusal and quarantines a malformed stored set without issuing work", async () => {
  const handler = vi.fn((operation: TerminalOperation) =>
    reply(
      operation,
      {
        state: "rejected",
        error: { status: 409, message: "Definite refusal" },
      },
      409,
    ),
  );
  const controller = new TerminalOperationController(transport(handler));
  await expect(controller.run(create)).rejects.toThrow("Definite refusal");
  expect(controller.snapshot()).toEqual([]);
  const valid = handler.mock.calls[0]![0];
  const corrupt = JSON.stringify([
    valid,
    { ...valid, intent: { ...valid.intent, params: {} } },
  ]);
  sessionStorage.setItem(key, corrupt);
  const reload = new TerminalOperationController(transport(handler));
  await expect(reload.run(create)).rejects.toThrow("storage is invalid");
  expect(handler).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem(key)).toBe(corrupt);
});

it("persists before dispatch and preserves a confirmed result when cleanup fails", async () => {
  let writeAllowed = false;
  const storage = {
    getItem: (name: string) => sessionStorage.getItem(name),
    setItem: (name: string, value: string) => {
      if (!writeAllowed || value === "[]")
        throw new Error("Storage unavailable");
      sessionStorage.setItem(name, value);
    },
  } as Storage;
  const handle = vi.fn(reply);
  const controller = new TerminalOperationController(
    transport(handle),
    () => storage,
  );
  await expect(controller.run(create)).rejects.toThrow("Storage unavailable");
  expect(handle).not.toHaveBeenCalled();
  writeAllowed = true;
  await expect(controller.run(create)).resolves.toEqual({ id: "terminal" });
  expect(controller.snapshot()).toMatchObject([{ outcome: "completed" }]);
  await expect(controller.retry(controller.snapshot()[0]!.key)).rejects.toThrow(
    "Storage unavailable",
  );
  expect(handle).toHaveBeenCalledOnce();
});

it("shows previous-version operations as unknown without replaying them", async () => {
  const prior = "inspire:terminal-operations:v1";
  const raw = '[{"oldWireRecord":true}]';
  sessionStorage.setItem(prior, raw);
  const handle = vi.fn(reply);
  const request = transport(handle);
  const controller = new TerminalOperationController(request);
  controller.restore();
  expect(controller.snapshot()).toMatchObject([
    { outcome: "unknown", canRetry: false },
  ]);
  await expect(controller.run(create)).rejects.toThrow("previous version");
  expect(request).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(prior)).toBe(raw);
  controller.stopTracking(controller.snapshot()[0]!.key);
  expect(sessionStorage.getItem(prior)).toBeNull();
  expect(request).not.toHaveBeenCalled();
  await expect(controller.run(create)).resolves.toEqual({ id: "terminal" });
});
