import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import {
  defaultTerminalDaemonAddress,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
} from "../../server/terminal-daemon-protocol.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { addressAcceptsConnections } from "../../server/terminal-daemon-socket.js";
import {
  connectTerminalDaemon,
  resolveTerminalDaemonSecret,
  terminalDaemonSecretPath,
} from "../../server/terminal-daemon-tls.js";
import { encodeTerminalIpcJson } from "../../server/terminal-ipc.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";

async function fixture(longRuntime = false) {
  const root = await mkdtemp(join(tmpdir(), "inspire-terminal-auth-"));
  const address = defaultTerminalDaemonAddress(root, "127.0.0.1", 4587, {
    environment: {
      ...process.env,
      XDG_RUNTIME_DIR: longRuntime ? join(root, "目录".repeat(40)) : root,
    },
  });
  const token = randomUUID() + randomUUID();
  return { root, address, token };
}

describe("terminal daemon peer authentication", () => {
  it("authenticates the default endpoint in a long runtime directory with its own persistent TLS authority", async () => {
    const f = await fixture(true);
    const basePath = join(f.root, "configured-token");
    const hostToken = await resolveAccessToken(undefined, basePath);
    const secret = await resolveTerminalDaemonSecret(basePath);
    const manager = new TerminalSessionManager();
    const read = vi.spyOn(manager, "getSettings");
    const server = new TerminalDaemonServer(f.address, secret, manager);
    const trusted = new TerminalDaemonClient(f.address, secret);
    const hostAuthority = new TerminalDaemonClient(f.address, hostToken);
    try {
      if (process.platform !== "win32")
        expect(Buffer.byteLength(f.address)).toBeLessThanOrEqual(
          process.platform === "darwin" ? 103 : 107,
        );
      expect(secret).not.toBe(hostToken);
      expect(await resolveTerminalDaemonSecret(basePath)).toBe(secret);
      expect((await readFile(basePath, "utf8")).trim()).toBe(hostToken);
      expect(
        (await readFile(terminalDaemonSecretPath(basePath), "utf8")).trim(),
      ).toBe(secret);
      await server.start();

      const raw = createConnection(f.address);
      raw.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        raw.once("close", () => resolve()),
      );
      raw.once("connect", () =>
        raw.end(
          encodeTerminalIpcJson({
            protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
            mode: "rpc",
            requestId: "plaintext",
            method: "getSettings",
            params: {},
          }),
        ),
      );
      await closed;
      await expect(hostAuthority.getSettings()).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      await trusted.probe();
      await expect(trusted.getSettings()).resolves.toMatchObject({
        persistOutput: false,
      });
    } finally {
      await hostAuthority.close();
      await trusted.close();
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("drains PTYs, closes peers and releases only this owner's endpoint", async () => {
    const f = await fixture();
    const manager = new TerminalSessionManager();
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(manager, "close").mockImplementation(() => drain);
    const old = new TerminalDaemonServer(f.address, f.token, manager);
    const unstarted = new TerminalDaemonServer(
      f.address,
      f.token,
      new TerminalSessionManager(),
    );
    const client = new TerminalDaemonClient(f.address, f.token);
    const peers: Socket[] = [];
    let stopping: Promise<void> | undefined;
    try {
      await old.start();
      await unstarted.stop();
      await client.probe();
      const raw = createConnection(f.address);
      const secure = connectTerminalDaemon(f.address, f.token);
      peers.push(raw, secure);
      const closed = peers.map(
        (peer) =>
          new Promise<void>((resolve) => {
            peer.on("error", () => {});
            peer.once("close", resolve);
          }),
      );
      await Promise.all([once(raw, "connect"), once(secure, "secureConnect")]);

      stopping = old.stop();
      expect(await addressAcceptsConnections(f.address)).toBe(true);
      release();
      await stopping;
      await Promise.all(closed);

      // Use a fresh server after closing the unstarted instance above.
      const replacement = new TerminalDaemonServer(
        f.address,
        f.token,
        new TerminalSessionManager(),
      );
      try {
        await replacement.start();
        await old.stop();
        await client.probe();
      } finally {
        await replacement.stop();
      }
    } finally {
      for (const peer of peers) peer.destroy();
      release();
      await stopping;
      await client.close();
      await old.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
