import { afterEach, expect, it, vi } from "vitest";
import {
  LazyTerminalService,
  type TerminalService,
} from "../../server/terminal-service.js";

const catalog = {
  catalogEpoch: "fixture",
  revision: 1,
  terminals: [],
  profiles: [],
};
function backend() {
  const writeInput = vi.fn();
  return {
    list: vi.fn().mockResolvedValue(catalog),
    operate: vi.fn().mockRejectedValue(new Error("Acknowledgement lost")),
    attach: vi.fn().mockResolvedValue({
      id: "attachment",
      terminalId: "terminal",
      writeInput,
      control: vi.fn(),
      detach: vi.fn(),
    }),
    close: vi.fn().mockResolvedValue(undefined),
    writeInput,
  };
}
function asService(client: ReturnType<typeof backend>): TerminalService {
  return client as unknown as TerminalService;
}
afterEach(() => vi.useRealTimers());

it("shares initialization, stays idle after failure, and retries only on a later request", async () => {
  vi.useFakeTimers();
  const client = backend();
  let accept!: (service: TerminalService) => void;
  const ready = new Promise<TerminalService>((resolve) => {
    accept = resolve;
  });
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new Error("Startup connection unavailable"))
    .mockReturnValueOnce(ready);
  const service = new LazyTerminalService(connect);
  await expect(service.list()).rejects.toThrow(
    "Startup connection unavailable",
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connect).toHaveBeenCalledTimes(1);
  const reads = [service.list(), service.list()];
  await Promise.resolve();
  expect(connect).toHaveBeenCalledTimes(2);
  accept(asService(client));
  await expect(Promise.all(reads)).resolves.toEqual([catalog, catalog]);
  expect(client.list).toHaveBeenCalledTimes(2);
  await service.close();
});

it("does not start initialization after close", async () => {
  const connect = vi.fn();
  const service = new LazyTerminalService(connect);
  const read = expect(service.list()).rejects.toMatchObject({
    code: "terminal_service_closed",
  });
  await service.close();
  await read;
  expect(connect).not.toHaveBeenCalled();
});

it("closes a late connection without reviving its old lifecycle or dispatching old requests", async () => {
  const oldClient = backend();
  const newClient = backend();
  let accept!: (service: TerminalService) => void;
  const old = new LazyTerminalService(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const rejected = expect(old.list()).rejects.toMatchObject({
    code: "terminal_service_closed",
  });
  await Promise.resolve();
  const closing = old.close();
  const current = new LazyTerminalService(async () => asService(newClient));
  await expect(current.list()).resolves.toEqual(catalog);
  accept(asService(oldClient));
  await Promise.all([closing, rejected]);
  expect(oldClient.close).toHaveBeenCalledOnce();
  expect(oldClient.list).not.toHaveBeenCalled();
  expect(newClient.close).not.toHaveBeenCalled();
  await expect(old.list()).rejects.toMatchObject({
    code: "terminal_service_closed",
  });
  await current.close();
});

it("never replays dispatched mutations or input after a lost acknowledgement", async () => {
  const client = backend();
  const connect = vi.fn().mockResolvedValue(asService(client));
  const service = new LazyTerminalService(connect);
  const attachment = await service.attach(
    { terminalId: "terminal", clientId: "browser", cols: 80, rows: 24 },
    { sendControl: vi.fn(), sendData: vi.fn(), close: vi.fn() },
  );
  attachment.writeInput(1, new Uint8Array([65]));
  const identity = { id: "operation", epoch: "fixture" };
  await expect(
    service.operate("restart", { id: "terminal" }, identity),
  ).rejects.toThrow("Acknowledgement lost");
  await expect(service.list()).resolves.toEqual(catalog);
  expect(connect).toHaveBeenCalledOnce();
  expect(client.operate).toHaveBeenCalledExactlyOnceWith(
    "restart",
    { id: "terminal" },
    identity,
  );
  expect(client.writeInput).toHaveBeenCalledExactlyOnceWith(
    1,
    new Uint8Array([65]),
  );
  await service.close();
});
