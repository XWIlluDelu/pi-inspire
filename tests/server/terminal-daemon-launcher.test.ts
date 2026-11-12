import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import {
  connectExistingTerminalDaemon,
  launchTerminalDaemon,
} from "../../server/terminal-daemon-launcher.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import * as daemonTls from "../../server/terminal-daemon-tls.js";
import { LazyTerminalService } from "../../server/terminal-service.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";

// Even a regression must never launch systemd or a real daemon in this fixture.
vi.mock(import("node:child_process"), async (original) => ({
  ...(await original()),
  spawn: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(spawn).mockImplementation(() => {
    throw new Error("Unexpected process launch");
  });
});

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "terminal-launcher-"));
  roots.push(root);
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\terminal-launcher-${randomUUID()}`
      : join(root, "ipc");
  const tokenPath = join(root, "token");
  const options = {
    root,
    host: "127.0.0.1",
    port: 1234,
    environment: {
      ...environment,
      INSPIRE_TERMINAL_DAEMON_ADDRESS: address,
      INSPIRE_TERMINAL_TOKEN_PATH: tokenPath,
      INSPIRE_TERMINAL_STATE_PATH: join(root, "state.json"),
    },
  };
  return { address, tokenPath, options };
}

it("leaves an unverified listener in place and withholds terminal authority from it", async () => {
  const { address, tokenPath, options } = await fixture();
  const secret = await daemonTls.resolveTerminalDaemonSecret(tokenPath);
  const client = new TerminalDaemonClient(address, secret);
  const project = "/private/request-project";
  const terminalId = "sensitive-terminal-id";
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (data) => {
      received.push(Buffer.from(data));
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
    await expect(launchTerminalDaemon(options)).rejects.toMatchObject({
      code: "terminal_service_connection_unverified",
      message: expect.stringContaining(
        "Existing terminal processes were left running",
      ),
    });
    for (const request of [
      () => client.list(project),
      () =>
        client.attach(
          { terminalId, clientId: "fixture-browser", cols: 80, rows: 24 },
          { sendData() {}, sendControl() {}, close() {} },
        ),
    ]) {
      received.length = 0;
      await expect(request()).rejects.toThrow();
      const wire = Buffer.concat(received);
      expect(wire.byteLength).toBeGreaterThan(0);
      for (const value of [secret, project, terminalId, "getCatalog"])
        expect(wire.includes(value)).toBe(false);
    }
    expect(server.listening).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("recovers on demand after an absent daemon and a lost read without launching a replacement", async () => {
  const { address, tokenPath, options } = await fixture();
  const project = "/workspace";
  const manager = new TerminalSessionManager({ profiles: [] });
  const catalog = manager.list(project);
  const reconnect = vi.fn(() => connectExistingTerminalDaemon(options));
  const recovering = new LazyTerminalService(reconnect);
  let server: TerminalDaemonServer | undefined;
  let client: Awaited<ReturnType<typeof launchTerminalDaemon>> | undefined;
  try {
    await expect(recovering.list(project)).rejects.toMatchObject({
      code: "terminal_daemon_unavailable",
    });
    await expect(
      readFile(daemonTls.terminalDaemonSecretPath(tokenPath)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }

    server = new TerminalDaemonServer(
      address,
      await daemonTls.resolveTerminalDaemonSecret(tokenPath),
      manager,
    );
    await server.start();
    client = await launchTerminalDaemon(options);
    await expect(client.list(project)).resolves.toEqual(catalog);

    const connect = daemonTls.connectTerminalDaemon;
    const read = vi.spyOn(manager, "list");
    vi.spyOn(daemonTls, "connectTerminalDaemon").mockImplementationOnce(
      (address, secret) => {
        const socket = connect(address, secret);
        read.mockImplementationOnce(() => {
          socket.destroy();
          return catalog;
        });
        return socket;
      },
    );
    await expect(client.list(project)).rejects.toMatchObject({
      code: "terminal_daemon_unavailable",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(project);
    await expect(client.list(project)).resolves.toEqual(catalog);
    await expect(
      Promise.all([recovering.list(project), recovering.list(project)]),
    ).resolves.toEqual([catalog, catalog]);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await recovering.close();
    await client?.close();
    await server?.stop();
  }
});

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly unref = vi.fn();
}

it("reports detached spawn errors through the launch result", async () => {
  const { options } = await fixture();
  vi.spyOn(TerminalDaemonClient.prototype, "probe").mockRejectedValue(
    new Error("No daemon"),
  );
  vi.mocked(spawn).mockImplementation((command) => {
    const child = new FakeChild();
    queueMicrotask(() => {
      if (command === "systemd-run") child.emit("exit", 1);
      else child.emit("error", new Error("Synthetic spawn failure"));
    });
    return child as unknown as ChildProcess;
  });
  await expect(launchTerminalDaemon(options)).rejects.toThrow(
    "Synthetic spawn failure",
  );
});

it.runIf(process.platform === "linux")(
  "bounds a hung systemd handoff and preserves user exports in its detached fallback",
  async () => {
    const userExport = "synthetic-private-value";
    const { options } = await fixture({
      USER_EXPORT: userExport,
      NOTIFY_SOCKET: "/host/notify",
      INVOCATION_ID: "host-incarnation",
      LISTEN_PID: "99",
    });
    vi.spyOn(TerminalDaemonClient.prototype, "probe")
      .mockRejectedValueOnce(new Error("No daemon"))
      .mockResolvedValue(undefined);
    const unit = new FakeChild();
    const detached = new FakeChild();
    let started!: () => void;
    const launching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(spawn).mockImplementation((command) => {
      if (command === "systemd-run") {
        started();
        return unit as unknown as ChildProcess;
      }
      queueMicrotask(() => detached.emit("spawn"));
      return detached as unknown as ChildProcess;
    });
    vi.useFakeTimers();
    const request = launchTerminalDaemon(options);
    await launching;
    const [, args, unitOptions] = vi.mocked(spawn).mock.calls[0]!;
    expect(args).toContain("--setenv=USER_EXPORT");
    expect(args?.join(" ")).not.toContain(userExport);
    expect(unitOptions?.env?.USER_EXPORT).toBe(userExport);

    await vi.advanceTimersByTimeAsync(2_000);
    await (await request).close();
    expect(unit.kill).toHaveBeenCalledWith("SIGKILL");
    const env = vi.mocked(spawn).mock.calls[1]?.[2]?.env;
    expect(env?.USER_EXPORT).toBe(userExport);
    for (const key of ["NOTIFY_SOCKET", "INVOCATION_ID", "LISTEN_PID"])
      expect(env).not.toHaveProperty(key);
    expect(detached.unref).toHaveBeenCalledOnce();
  },
);
