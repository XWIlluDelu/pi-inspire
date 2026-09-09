import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";
import { launchTerminalDaemon } from "../../server/terminal-daemon-launcher.js";
import {
  decodeTerminalIpcJson,
  TerminalIpcDecoder,
} from "../../server/terminal-ipc.js";

// Even a regression must never launch systemd or a real daemon in this fixture.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("Unexpected process launch");
  }),
}));

it("does not replace a listening incompatible daemon or terminate its independent work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-owner-fence-"));
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\terminal-owner-fence-${randomUUID()}`
      : join(directory, "terminal.sock");
  const tokenPath = join(directory, "token");
  const token = await resolveAccessToken(undefined, tokenPath);
  const sockets = new Set<Socket>();
  const modes: unknown[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new TerminalIpcDecoder();
    socket.on("data", (data) => {
      for (const frame of decoder.push(
        typeof data === "string" ? Buffer.from(data) : data,
      )) {
        const message = decodeTerminalIpcJson(frame.payload) as {
          token: string;
          mode: string;
        };
        expect(message.token).toBe(token);
        modes.push(message.mode);
        // An incompatible owner's rejected handshake is observation failure,
        // not permission to issue its destructive replacement handshake.
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    await expect(
      launchTerminalDaemon({
        root: directory,
        host: "127.0.0.1",
        port: 1234,
        environment: {
          INSPIRE_TERMINAL_DAEMON_ADDRESS: address,
          INSPIRE_TERMINAL_TOKEN_PATH: tokenPath,
          INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
        },
      }),
    ).rejects.toThrow("inspire restart --all");
    expect(server.listening).toBe(true);
    expect(modes).toEqual(["rpc"]);
    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
