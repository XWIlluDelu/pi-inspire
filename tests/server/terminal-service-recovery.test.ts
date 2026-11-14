import { expect, it, vi } from "vitest";
import {
  TerminalConnection,
  type TerminalService,
} from "../../server/terminal-service.js";

const catalog = {
  catalogEpoch: "fixture",
  revision: 1,
  terminals: [],
  profiles: [],
};
function backend() {
  return {
    list: vi.fn().mockResolvedValue(catalog),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
function asService(client: ReturnType<typeof backend>): TerminalService {
  return client as unknown as TerminalService;
}
it("cancels same-tick initialization when the service closes", async () => {
  const connect = vi.fn();
  const service = new TerminalConnection(connect);
  const read = expect(
    service.run((terminal) => terminal.list()),
  ).rejects.toMatchObject({
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
  const old = new TerminalConnection(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const rejected = expect(
    old.run((terminal) => terminal.list()),
  ).rejects.toMatchObject({
    code: "terminal_service_closed",
  });
  await Promise.resolve();
  const closing = old.close();
  const current = new TerminalConnection(async () => asService(newClient));
  await expect(current.run((terminal) => terminal.list())).resolves.toEqual(
    catalog,
  );
  accept(asService(oldClient));
  await Promise.all([closing, rejected]);
  expect(oldClient.close).toHaveBeenCalledOnce();
  expect(oldClient.list).not.toHaveBeenCalled();
  expect(newClient.close).not.toHaveBeenCalled();
  await expect(old.run((terminal) => terminal.list())).rejects.toMatchObject({
    code: "terminal_service_closed",
  });
  await current.close();
});
