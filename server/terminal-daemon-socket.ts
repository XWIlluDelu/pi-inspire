import { createConnection } from "node:net";

export function addressAcceptsConnections(address: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection(address);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 250);
    timeout.unref?.();
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolvePromise(false);
    });
  });
}
