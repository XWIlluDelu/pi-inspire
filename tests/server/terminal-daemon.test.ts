import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import {
  type TerminalAttachmentSink,
  TerminalServiceError,
} from "../../server/terminal-service.js";
import {
  type TerminalPtyFactory,
  TerminalSessionManager,
} from "../../server/terminal-session-manager.js";
import {
  decodeTerminalServerDataFrame,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts.js";

import { FakePty } from "./fixtures/terminal-pty.js";

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

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-terminal-daemon-"));
  directories.push(directory);
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\inspire-terminal-test-${randomUUID()}`
      : join(directory, "terminal.sock");
  const ptys: FakePty[] = [];
  const ptyFactory: TerminalPtyFactory = () => {
    const pty = new FakePty(4321);
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
  const server = new TerminalDaemonServer(address, "test-secret", manager);
  await server.start();
  const client = new TerminalDaemonClient(address, "test-secret");
  return { address, client, directory, manager, ptys, server };
}

describe("terminal daemon", () => {
  it("delivers attachment refusals to a connected Host and remains available", async () => {
    const { client, manager, server } = await setup();
    vi.spyOn(manager, "attach").mockRejectedValue(
      new TerminalServiceError("terminal_busy", 409, "Terminal is restarting"),
    );
    try {
      await expect(
        client.attach(
          { terminalId: "fixture", clientId: "fixture", cols: 80, rows: 24 },
          new Sink(),
        ),
      ).rejects.toMatchObject({
        code: "terminal_busy",
        status: 409,
        message: "Terminal is restarting",
      });
      await expect(client.probe()).resolves.toBeUndefined();
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("survives an attachment rejection after the Host connection closes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-terminal-disconnect-"),
    );
    directories.push(directory);
    const address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\inspire-terminal-test-${randomUUID()}`
        : join(directory, "terminal.sock");
    const moduleUrl = (name: string) =>
      JSON.stringify(new URL(`../../server/${name}.ts`, import.meta.url).href);
    // A real child process makes an unhandled rejection fatal, as it is in the
    // daemon, without taking down Vitest or creating any actual PTYs.
    const script = `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { setTimeout as delay } from "node:timers/promises";
      import { TerminalDaemonClient } from ${moduleUrl("terminal-daemon-client")};
      import { TerminalDaemonServer } from ${moduleUrl("terminal-daemon-server")};
      import { TERMINAL_DAEMON_PROTOCOL_VERSION } from ${moduleUrl("terminal-daemon-protocol")};
      import { connectTerminalDaemon } from ${moduleUrl("terminal-daemon-tls")};
      import { encodeTerminalIpcJson } from ${moduleUrl("terminal-ipc")};
      import { UnavailableTerminalService } from ${moduleUrl("terminal-service")};
      const address = ${JSON.stringify(address)};
      const service = new UnavailableTerminalService("isolated fixture");
      let rejectAttach, attachmentSink, received;
      const admitted = new Promise(resolve => { received = resolve; });
      service.attach = (_options, sink) => {
        attachmentSink = sink;
        received();
        return new Promise((_resolve, reject) => { rejectAttach = reject; });
      };
      const server = new TerminalDaemonServer(address, "fixture-secret", service);
      await server.start();
      const socket = connectTerminalDaemon(address, "fixture-secret");
      socket.on("error", () => {});
      await once(socket, "secureConnect");
      socket.write(encodeTerminalIpcJson({
        protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        mode: "attach", terminalId: "fixture",
        options: { terminalId: "fixture", clientId: "fixture", cols: 80, rows: 24 },
      }));
      await admitted;
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
      let peerClosed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { attachmentSink.sendControl({ type: "heartbeat" }); }
        catch { peerClosed = true; break; }
        await delay(10);
      }
      assert(peerClosed, "the daemon must observe Host disconnection first");
      rejectAttach(new Error("attachment failed after disconnection"));
      await delay(20);
      const client = new TerminalDaemonClient(address, "fixture-secret");
      await client.probe();
      await client.close();
      await server.stop();
      console.log("daemon survived the disconnected attachment");
    `;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 10_000, env: process.env },
    );
    expect(stdout).toContain("daemon survived the disconnected attachment");
    expect(stderr).toBe("");
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
