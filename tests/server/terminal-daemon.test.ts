import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import type { TerminalAttachmentSink } from "../../server/terminal-service.js";
import {
  type TerminalPty,
  type TerminalPtyFactory,
  TerminalSessionManager,
} from "../../server/terminal-session-manager.js";
import {
  decodeTerminalServerDataFrame,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts.js";

class FakePty implements TerminalPty {
  readonly pid = 4321;
  readonly process = "bash";
  readonly writes: Buffer[] = [];
  private readonly dataListeners = new Set<(data: string | Buffer) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  private exited = false;

  onData(listener: (data: string | Buffer) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  resize(): void {}

  write(data: string | Buffer): void {
    this.writes.push(Buffer.from(data));
  }

  kill(signal?: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners)
      listener({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : 1 });
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class Sink implements TerminalAttachmentSink {
  readonly controls: TerminalServerControlMessage[] = [];
  readonly data: Uint8Array[] = [];
  readonly closes: Array<[number, string]> = [];

  sendControl(message: TerminalServerControlMessage): void {
    this.controls.push(message);
  }

  sendData(frame: Uint8Array): void {
    this.data.push(Buffer.from(frame));
  }

  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(onProtocolReplacement: () => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-terminal-daemon-"));
  directories.push(directory);
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\inspire-terminal-test-${randomUUID()}`
      : join(directory, "terminal.sock");
  const ptys: FakePty[] = [];
  const ptyFactory: TerminalPtyFactory = () => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const manager = new TerminalSessionManager({
    profiles: [
      {
        id: "bash",
        label: "Bash",
        shell: "/bin/bash",
        args: ["-l"],
        available: true,
        isDefault: true,
      },
    ],
    ptyFactory,
  });
  const server = new TerminalDaemonServer(
    address,
    "test-secret",
    manager,
    onProtocolReplacement,
  );
  await server.start();
  const client = new TerminalDaemonClient(address, "test-secret");
  return { address, client, directory, manager, ptys, server };
}

describe("terminal daemon", () => {
  it("only accepts authenticated replacement from a different protocol", async () => {
    const replaced = vi.fn();
    const { address, client, server } = await setup(replaced);
    expect(await client.requestProtocolReplacement()).toBe(false);
    expect(
      await new TerminalDaemonClient(
        address,
        "wrong-secret",
      ).requestProtocolReplacement(0),
    ).toBe(false);
    expect(await client.requestProtocolReplacement(0)).toBe(true);
    await vi.waitFor(() => expect(replaced).toHaveBeenCalledOnce());
    await client.close();
    await server.stop();
  });

  it.each(["remove", "restart"] as const)(
    "keeps the %s RPC open through graceful stop and delayed PTY exit",
    async (method) => {
      const { client, directory, ptys, server } = await setup();
      const terminal = await client.create({ cwd: directory });
      const pty = ptys[0]!;
      const exit = pty.kill.bind(pty);
      let markStopping!: () => void;
      const stopping = new Promise<void>((resolve) => {
        markStopping = resolve;
      });
      vi.spyOn(pty, "kill").mockImplementation((signal) => {
        markStopping();
        if (signal === "SIGKILL") setTimeout(() => exit(signal), 4_000);
      });
      vi.useFakeTimers();
      try {
        let settled = false;
        const request =
          method === "remove"
            ? client.remove(terminal.id, false)
            : client.restart(terminal.id);
        const result = request.then(
          (receipt) => {
            settled = true;
            return receipt;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        // The request has reached the real IPC server before time advances.
        await stopping;
        await vi.advanceTimersByTimeAsync(5_500);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        await expect(result).resolves.toMatchObject({
          catalogEpoch: terminal.catalogEpoch,
        });
        const catalog = await client.list(directory);
        if (method === "remove") expect(catalog.terminals).toEqual([]);
        else {
          expect(catalog.terminals).toMatchObject([
            { id: terminal.id, status: "running" },
          ]);
          expect(catalog.terminals[0]!.outputEpoch).not.toBe(
            terminal.outputEpoch,
          );
        }
      } finally {
        exit();
        vi.useRealTimers();
        await client.close();
        await server.stop();
      }
    },
  );

  it("keeps terminal RPC and byte streams behind authenticated IPC", async () => {
    const { address, client, directory, ptys, server } = await setup();
    await client.probe();
    expect(await client.getSettings()).toEqual({
      persistOutput: false,
      historyRetentionDays: 30,
    });
    expect(
      await client.updateSettings({
        persistOutput: true,
        historyRetentionDays: 14,
      }),
    ).toEqual({ persistOutput: true, historyRetentionDays: 14 });
    await client.clearHistory();
    await expect(
      new TerminalDaemonClient(address, "wrong-secret").probe(),
    ).rejects.toThrow();

    const terminal = await client.create({
      cwd: directory,
      cols: 90,
      rows: 28,
    });
    const catalog = await client.list(directory);
    expect(catalog.terminals).toMatchObject([
      { id: terminal.id, status: "running" },
    ]);

    const sink = new Sink();
    const attachment = await client.attach(
      {
        terminalId: terminal.id,
        clientId: "browser-a",
        cols: 91,
        rows: 29,
      },
      sink,
    );
    await vi.waitFor(() =>
      expect(
        sink.controls.some(
          (message) =>
            message.type === "attached" &&
            message.terminal.cols === 91 &&
            message.terminal.rows === 29,
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        sink.controls.some((message) => message.type === "replay_complete"),
      ).toBe(true),
    );

    attachment.writeInput(1, Buffer.from("echo daemon\r"));
    await vi.waitFor(() =>
      expect(ptys[0]?.writes.map(String)).toEqual(["echo daemon\r"]),
    );
    ptys[0]?.emitData("daemon output\r\n");
    await vi.waitFor(() =>
      expect(
        sink.data
          .map((frame) => decodeTerminalServerDataFrame(frame))
          .some((frame) =>
            Buffer.from(frame.data).toString().includes("daemon output"),
          ),
      ).toBe(true),
    );

    attachment.detach();
    await client.close();
    await server.stop();
  });
});
