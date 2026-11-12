import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { processStartIdentity } from "../../server/instance-state.mjs";
import type { TerminalDaemonInfo } from "../../server/terminal-daemon-configuration.js";
import type { TerminalDescriptor } from "../../shared/terminal-contracts.js";
import { terminalDaemonFixture } from "./fixtures/terminal-daemon.js";

describe("terminal daemon", () => {
  it("keeps lifecycle controls available after a descendant blocks shutdown", async () => {
    let info: TerminalDaemonInfo;
    const shutdown = vi.fn();
    const fixture = await terminalDaemonFixture({ info: () => info, shutdown });
    const { client, directory, address, manager, spawns, server } = fixture;
    let descendantsRetired = false;
    try {
      info = {
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
      const terminal = await manager.create({ cwd: directory });
      const pty = spawns[0]!.pty;
      Object.assign(pty, {
        killTree: async () => pty.emitExit(0),
        waitForTreeExit: async () => descendantsRetired,
      });
      await expect(server.stop()).rejects.toMatchObject({
        code: "terminal_cleanup_failed",
      });
      expect(manager.list().terminals).toMatchObject([
        { id: terminal.id, status: "exited" },
      ]);
      await expect(client.daemonInfo()).resolves.toEqual(info);
      await expect(client.probe()).rejects.toThrow();

      await client.shutdownDaemon(info.instanceId, true);
      expect(shutdown).toHaveBeenCalledExactlyOnceWith(info.instanceId, true);
      descendantsRetired = true;
      await server.stop();
      expect(manager.list().terminals).toEqual([]);
    } finally {
      descendantsRetired = true;
      await fixture.close();
    }
  });

  it("survives an attachment rejection after the Host connection closes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-terminal-disconnect-"),
    );
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
      import { TerminalSessionManager } from ${moduleUrl("terminal-session-manager")};
      const address = ${JSON.stringify(address)};
      const service = new TerminalSessionManager();
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
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 10_000, env: process.env },
      );
      expect(stdout).toContain("daemon survived the disconnected attachment");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a failed restart, accepts a fresh restart and waits for delayed removal", async () => {
    const fixture = await terminalDaemonFixture();
    const { client, directory, manager, spawns } = fixture;
    try {
      const epoch = await client.operationEpoch();
      const identity = () => ({ id: randomUUID(), epoch });
      const terminal = await client.operate<TerminalDescriptor>(
        "create",
        { request: { cwd: directory } },
        identity(),
      );
      const id = terminal.id;
      const pty = spawns[0]!.pty;
      let markStopping!: () => void;
      const stopping = new Promise<void>((resolve) => {
        markStopping = resolve;
      });
      vi.spyOn(pty, "kill").mockImplementation(markStopping);
      const restart = vi.spyOn(manager, "restart");
      const failedOperation = identity();
      const resend = () => client.operate("restart", { id }, failedOperation);
      vi.useFakeTimers();

      const failure = { code: "terminal_stop_timeout", status: 503 };
      const first = expect(resend()).rejects.toMatchObject(failure);
      await stopping;
      await vi.advanceTimersByTimeAsync(7_000);
      await first;
      pty.emitExit(0);

      await expect(resend()).rejects.toMatchObject(failure);
      expect(restart).toHaveBeenCalledOnce();
      expect(spawns).toHaveLength(1);
      expect((await client.list(directory)).terminals).toMatchObject([
        { id, status: "exited" },
      ]);

      await expect(
        client.operate("restart", { id }, identity()),
      ).resolves.toMatchObject({
        id,
        status: "running",
      });
      expect(spawns).toHaveLength(2);
      const restarted = spawns[1]!.pty;
      const exit = restarted.kill.bind(restarted);
      let markRemoving!: () => void;
      const removing = new Promise<void>((resolve) => {
        markRemoving = resolve;
      });
      vi.spyOn(restarted, "kill").mockImplementation((signal) => {
        markRemoving();
        if (signal === "SIGKILL") setTimeout(() => exit(signal), 4_000);
      });
      let settled = false;
      const result = client
        .operate("remove", { id, force: false }, identity())
        .finally(() => {
          settled = true;
        });
      const receipt = expect(result).resolves.toMatchObject({
        catalogEpoch: terminal.catalogEpoch,
      });
      await removing;
      await vi.advanceTimersByTimeAsync(5_500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await receipt;
      expect((await client.list(directory)).terminals).toEqual([]);
    } finally {
      for (const { pty } of spawns) pty.emitExit(0);
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
