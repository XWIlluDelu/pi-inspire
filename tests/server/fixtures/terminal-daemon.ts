import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalDaemonClient } from "../../../server/terminal-daemon-client.js";
import { TerminalDaemonServer } from "../../../server/terminal-daemon-server.js";
import { terminalManagerWithFakePty } from "./terminal-pty.js";

export async function terminalDaemonFixture(
  lifecycle?: ConstructorParameters<typeof TerminalDaemonServer>[3],
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-daemon-")),
  );
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\inspire-terminal-test-${randomUUID()}`
      : join(directory, "terminal.sock");
  const secret = randomUUID();
  const { manager, spawns } = terminalManagerWithFakePty();
  const server = new TerminalDaemonServer(address, secret, manager, lifecycle);
  try {
    await server.start();
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const connect = () => new TerminalDaemonClient(address, secret);
  const client = connect();
  return {
    directory,
    address,
    secret,
    manager,
    spawns,
    server,
    client,
    connect,
    async close() {
      await client.close();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
