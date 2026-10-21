import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { expect, it, vi } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";
import {
  connectExistingTerminalDaemon,
  launchTerminalDaemon,
} from "../../server/terminal-daemon-launcher.js";
import { TERMINAL_DAEMON_PROTOCOL_VERSION } from "../../server/terminal-daemon-protocol.js";
import {
  resolveTerminalDaemonSecret,
  terminalDaemonTlsOptions,
} from "../../server/terminal-daemon-tls.js";
import {
  decodeTerminalIpcJson,
  encodeTerminalIpcJson,
  TerminalIpcDecoder,
} from "../../server/terminal-ipc.js";
import { LazyTerminalService } from "../../server/terminal-service.js";

// Even a regression must never launch systemd or a real daemon in this fixture.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("Unexpected process launch");
  }),
}));

it("preserves an unverified listener without recommending destructive replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-owner-fence-"));
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\terminal-owner-fence-${randomUUID()}`
      : join(directory, "terminal.sock");
  const tokenPath = join(directory, "token");
  const token = await resolveAccessToken(undefined, tokenPath);
  const sockets = new Set<Socket>();
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (data) => {
      received.push(Buffer.from(data));
      // A pre-TLS owner cannot authenticate. Its refusal must not authorize
      // replacement, and the new client must not disclose the old raw token.
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    const request = launchTerminalDaemon({
      root: directory,
      host: "127.0.0.1",
      port: 1234,
      environment: {
        INSPIRE_TERMINAL_DAEMON_ADDRESS: address,
        INSPIRE_TERMINAL_TOKEN_PATH: tokenPath,
        INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
      },
    });
    await expect(request).rejects.toMatchObject({
      code: "terminal_service_connection_unverified",
      message: expect.stringContaining(
        "Existing terminal processes were left running",
      ),
    });
    await expect(request).rejects.not.toThrow(
      /restart --force|Restart all|incompatible/,
    );
    expect(server.listening).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(Buffer.concat(received).includes(Buffer.from(token))).toBe(false);
    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("reconnects without creating authority or launching a missing daemon", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "terminal-reconnect-readonly-"),
  );
  const tokenPath = join(directory, "token");
  try {
    await expect(
      connectExistingTerminalDaemon({
        root: directory,
        host: "127.0.0.1",
        port: 1234,
        environment: {
          INSPIRE_TERMINAL_DAEMON_ADDRESS:
            process.platform === "win32"
              ? `\\\\.\\pipe\\terminal-readonly-${randomUUID()}`
              : join(directory, "terminal.sock"),
          INSPIRE_TERMINAL_TOKEN_PATH: tokenPath,
          INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
        },
      }),
    ).rejects.toMatchObject({ code: "terminal_daemon_unavailable" });
    await expect(readFile(tokenPath + ".tls-v3")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps compatible data usable without lifecycle support and retries a disconnected read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-data-compat-"));
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\terminal-data-compat-${randomUUID()}`
      : join(directory, "terminal.sock");
  const tokenPath = join(directory, "token");
  const token = await resolveTerminalDaemonSecret(tokenPath);
  const sockets = new Set<Socket>();
  const requests: Array<{
    method: string;
    mode: string;
    protocolVersion?: number;
  }> = [];
  let failNextRead = false;
  const catalog = {
    catalogEpoch: "fixture",
    revision: 1,
    terminals: [],
    profiles: [],
  };
  const server = createTlsServer(terminalDaemonTlsOptions(token), (socket) => {
    sockets.add(socket);
    const decoder = new TerminalIpcDecoder();
    socket.on("data", (data) => {
      for (const frame of decoder.push(
        typeof data === "string" ? Buffer.from(data) : data,
      )) {
        const request = decodeTerminalIpcJson(frame.payload) as {
          requestId: string;
          method: string;
          mode: string;
          protocolVersion?: number;
        };
        requests.push(request);
        if (request.method === "getCatalog" && failNextRead) {
          failNextRead = false;
          socket.destroy();
          return;
        }
        socket.end(
          encodeTerminalIpcJson(
            request.mode === "lifecycle"
              ? {
                  requestId: request.requestId,
                  ok: false,
                  error: {
                    code: "unsupported_lifecycle",
                    status: 400,
                    message: "Lifecycle unsupported",
                  },
                }
              : {
                  requestId: request.requestId,
                  ok: true,
                  result:
                    request.method === "ping"
                      ? { operationEpoch: "fixture" }
                      : catalog,
                },
          ),
        );
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  const options = {
    root: directory,
    host: "127.0.0.1",
    port: 1234,
    environment: {
      INSPIRE_TERMINAL_DAEMON_ADDRESS: address,
      INSPIRE_TERMINAL_TOKEN_PATH: tokenPath,
      INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
    },
  };
  const reconnect = vi.fn(() => connectExistingTerminalDaemon(options));
  const recovering = new LazyTerminalService(reconnect);
  let client: Awaited<ReturnType<typeof launchTerminalDaemon>> | undefined;
  try {
    await expect(recovering.list("/workspace")).rejects.toMatchObject({
      code: "terminal_daemon_unavailable",
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    client = await launchTerminalDaemon(options);
    await expect(client.list("/workspace")).resolves.toEqual(catalog);
    expect(requests.map(({ method }) => method)).toEqual([
      "ping",
      "getCatalog",
    ]);
    expect(
      requests.every(
        ({ protocolVersion }) =>
          protocolVersion === TERMINAL_DAEMON_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    await expect(client.daemonInfo()).rejects.toMatchObject({
      code: "unsupported_lifecycle",
    });
    await expect(client.list("/workspace")).resolves.toEqual(catalog);
    failNextRead = true;
    await expect(client.list("/workspace")).rejects.toMatchObject({
      code: "terminal_daemon_unavailable",
    });
    await expect(client.list("/workspace")).resolves.toEqual(catalog);
    await expect(
      Promise.all([
        recovering.list("/workspace"),
        recovering.list("/workspace"),
      ]),
    ).resolves.toEqual([catalog, catalog]);
    expect(reconnect).toHaveBeenCalledTimes(2);
    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await recovering.close();
    await client?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
