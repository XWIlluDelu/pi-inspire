import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { processStartIdentity } from "../../server/instance-state.mjs";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import type { TerminalDaemonInfo } from "../../server/terminal-daemon-configuration.js";
import { defaultTerminalDaemonAddress } from "../../server/terminal-daemon-protocol.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";

it("keeps stable authenticated lifecycle controls available through a failed shutdown", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "terminal-lifecycle-protocol-"),
  );
  const address = defaultTerminalDaemonAddress(directory, "127.0.0.1", 4555);
  const manager = new TerminalSessionManager();
  const info: TerminalDaemonInfo = {
    lifecycleVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    processStartTime: await processStartIdentity(process.pid),
    configuration: {
      root: directory,
      host: "127.0.0.1",
      port: 4555,
      address,
      tokenPath: join(directory, "token"),
      statePath: join(directory, "state"),
    },
    runningTerminals: 0,
    stopping: false,
    systemdUnit: null,
  };
  const shutdown = vi.fn();
  const server = new TerminalDaemonServer(address, "isolated-secret", manager, {
    info: () => info,
    shutdown,
  });
  const client = new TerminalDaemonClient(address, "isolated-secret");
  try {
    await server.start();
    // Lifecycle has its own versioned envelope, independent of data protocol.
    expect(await client.daemonInfo()).toEqual(info);
    await client.shutdownDaemon(info.instanceId, false);
    expect(shutdown).toHaveBeenCalledWith(info.instanceId, false);
    const close = vi
      .spyOn(manager, "close")
      .mockRejectedValueOnce(new Error("Unconfirmed PTY exit"));
    await expect(server.stop()).rejects.toThrow("Unconfirmed PTY exit");
    await expect(client.daemonInfo()).resolves.toEqual(info);
    await expect(client.probe()).rejects.toThrow();
    await server.stop();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
