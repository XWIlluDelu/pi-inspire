import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { defaultTerminalDaemonAddress } from "../../server/terminal-daemon-protocol.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { addressAcceptsConnections } from "../../server/terminal-daemon-socket.js";
import {
  resolveTerminalDaemonSecret,
  terminalDaemonSecretPath,
} from "../../server/terminal-daemon-tls.js";
import { encodeTerminalIpcJson } from "../../server/terminal-ipc.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-terminal-auth-"));
  const address = defaultTerminalDaemonAddress(root, "127.0.0.1", 4587);
  const token = randomUUID() + randomUUID();
  return { root, address, token };
}

describe("terminal daemon peer authentication", () => {
  it("uses a fresh persistent TLS authority instead of the potentially disclosed plaintext-era token", async () => {
    const f = await fixture();
    const basePath = join(f.root, "configured-token");
    const oldToken = await resolveAccessToken(undefined, basePath);
    const secret = await resolveTerminalDaemonSecret(basePath);
    const server = new TerminalDaemonServer(
      f.address,
      secret,
      new TerminalSessionManager(),
    );
    const trusted = new TerminalDaemonClient(f.address, secret);
    const old = new TerminalDaemonClient(f.address, oldToken);
    try {
      expect(secret).not.toBe(oldToken);
      expect(await resolveTerminalDaemonSecret(basePath)).toBe(secret);
      expect((await readFile(basePath, "utf8")).trim()).toBe(oldToken);
      expect(
        (await readFile(terminalDaemonSecretPath(basePath), "utf8")).trim(),
      ).toBe(secret);
      await server.start();
      await expect(old.probe()).rejects.toThrow();
      await trusted.probe();
    } finally {
      await old.close();
      await trusted.close();
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each(["rpc", "attach"] as const)(
    "does not disclose credentials or request data to an unverified %s listener",
    async (mode) => {
      const f = await fixture();
      const received: Buffer[] = [];
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.on("data", (data) => {
          received.push(Buffer.from(data));
          // An old/fake plaintext daemon offers success without possessing the
          // PSK. The client must never promote this into an authenticated peer.
          socket.end(
            encodeTerminalIpcJson({ ok: true, result: {}, type: "attached" }),
          );
        });
      });
      const client = new TerminalDaemonClient(f.address, f.token);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(f.address, resolve);
        });
        const secretPath = "/private/request-project";
        if (mode === "rpc")
          await expect(client.list(secretPath)).rejects.toThrow();
        else
          await expect(
            client.attach(
              {
                terminalId: "sensitive-terminal-id",
                clientId: "fixture-browser",
                cols: 80,
                rows: 24,
              },
              { sendData() {}, sendControl() {}, close() {} },
            ),
          ).rejects.toThrow();
        const wire = Buffer.concat(received);
        expect(wire.byteLength).toBeGreaterThan(0);
        for (const secret of [
          f.token,
          secretPath,
          "sensitive-terminal-id",
          "getCatalog",
        ])
          expect(wire.includes(Buffer.from(secret))).toBe(false);
      } finally {
        await client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it("never downgrades to plaintext and rejects clients with the wrong PSK", async () => {
    const f = await fixture();
    const manager = new TerminalSessionManager();
    const read = vi.spyOn(manager, "getSettings");
    const server = new TerminalDaemonServer(f.address, f.token, manager);
    const client = new TerminalDaemonClient(f.address, f.token);
    try {
      await server.start();
      const raw = createConnection(f.address);
      raw.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        raw.once("close", () => resolve()),
      );
      raw.once("connect", () =>
        raw.end(
          encodeTerminalIpcJson({
            protocolVersion: 2,
            mode: "rpc",
            token: f.token,
            requestId: "old",
            method: "getSettings",
            params: {},
          }),
        ),
      );
      await closed;
      await expect(
        new TerminalDaemonClient(f.address, "wrong-PSK").getSettings(),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      await expect(client.getSettings()).resolves.toMatchObject({
        persistOutput: false,
      });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("stops pending unauthenticated connections without waiting for their TLS deadline", async () => {
    const f = await fixture();
    const server = new TerminalDaemonServer(
      f.address,
      f.token,
      new TerminalSessionManager(),
    );
    let raw: Socket | undefined;
    try {
      await server.start();
      raw = createConnection(f.address);
      raw.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        raw!.once("close", () => resolve()),
      );
      await new Promise<void>((resolve) => raw!.once("connect", resolve));
      await server.stop();
      await closed;
    } finally {
      raw?.destroy();
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not unlink a live endpoint when an unstarted owner is closed", async () => {
    const f = await fixture();
    const server = new TerminalDaemonServer(
      f.address,
      f.token,
      new TerminalSessionManager(),
    );
    const unstarted = new TerminalDaemonServer(
      f.address,
      "not-owner",
      new TerminalSessionManager(),
    );
    const client = new TerminalDaemonClient(f.address, f.token);
    try {
      await server.start();
      await unstarted.stop();
      await client.probe();
    } finally {
      await client.close();
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps its endpoint through PTY drain and never unlinks a successor",
    async () => {
      const f = await fixture();
      const manager = new TerminalSessionManager();
      let release!: () => void;
      const drain = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(manager, "close").mockImplementation(() => drain);
      const old = new TerminalDaemonServer(f.address, f.token, manager);
      const successor = new TerminalDaemonServer(
        f.address,
        f.token,
        new TerminalSessionManager(),
      );
      const client = new TerminalDaemonClient(f.address, f.token);
      let stopping: Promise<void> | undefined;
      try {
        await old.start();
        stopping = old.stop();
        expect((await lstat(f.address)).isSocket()).toBe(true);
        expect(await addressAcceptsConnections(f.address)).toBe(true);
        release();
        await stopping;
        await successor.start();
        await old.stop();
        await client.probe();
      } finally {
        release();
        await stopping;
        await client.close();
        await successor.stop();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
});
