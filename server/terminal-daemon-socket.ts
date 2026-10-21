import { createConnection } from "node:net";

// A confirmed duplicate owner needs an operator decision, not a crash-restart loop.
export const TERMINAL_DAEMON_OWNER_CONFLICT_EXIT_CODE = 78;

export class TerminalDaemonOwnerConflictError extends Error {
  readonly code = "terminal_daemon_owner_conflict";

  constructor() {
    super(
      "The Inspire terminal daemon is already running. Existing terminals were left running.",
    );
    this.name = "TerminalDaemonOwnerConflictError";
  }
}

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
