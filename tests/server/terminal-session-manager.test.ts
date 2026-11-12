import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { terminalTreeInspector } from "../../server/terminal-process-tree.js";
import type { TerminalAttachmentSink } from "../../server/terminal-service.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";
import {
  decodeTerminalServerDataFrame,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts.js";

import {
  FakePty,
  terminalManagerWithFakePty,
} from "./fixtures/terminal-pty.js";

class FakeSink implements TerminalAttachmentSink {
  readonly controls: TerminalServerControlMessage[] = [];
  readonly frames: Uint8Array[] = [];
  readonly closes: Array<[number, string]> = [];
  failData = false;

  sendControl(message: TerminalServerControlMessage): void {
    this.controls.push(message);
  }

  sendData(frame: Uint8Array): void {
    if (this.failData) throw new Error("sink closed");
    this.frames.push(frame);
  }

  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

function setup(ownerReconnectGraceMs = 30_000) {
  let nextUuid = 0;
  return terminalManagerWithFakePty({
    uuid: () => `uuid-${++nextUuid}`,
    ownerReconnectGraceMs,
  });
}

function attachedMessage(sink: FakeSink) {
  return sink.controls.find((message) => message.type === "attached");
}

describe("TerminalSessionManager", () => {
  it("disposes the headless terminal when the PTY factory fails", async () => {
    const { Terminal } = createRequire(import.meta.url)(
      "@xterm/headless",
    ) as typeof import("@xterm/headless");
    const dispose = vi.spyOn(Terminal.prototype, "dispose");
    let failSpawn = true;
    const manager = new TerminalSessionManager({
      profiles: [
        {
          id: "test",
          label: "Test",
          shell: "test-shell",
          args: [],
          available: true,
          isDefault: true,
        },
      ],
      ptyFactory: () => {
        if (failSpawn) throw new Error("PTY spawn failed");
        return new FakePty();
      },
    });
    try {
      await expect(manager.create({ cwd: process.cwd() })).rejects.toThrow(
        "PTY spawn failed",
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(manager.list().terminals).toEqual([]);
      failSpawn = false;
      await expect(
        manager.create({ cwd: process.cwd() }),
      ).resolves.toMatchObject({
        status: "running",
      });
    } finally {
      await manager.close();
      dispose.mockRestore();
    }
  });

  it("restores tab metadata without launching missing or retained profiles", async () => {
    const first = setup();
    const terminal = await first.manager.create({ cwd: process.cwd() });
    const unavailable = await first.manager.create({ cwd: process.cwd() });
    await first.manager.rename(terminal.id, { title: "Build shell" });
    const state = first.manager.exportState();
    state.terminals.find(({ id }) => id === terminal.id)!.currentCwd =
      "relative/path\u001b]2;spoof";
    state.terminals.find(({ id }) => id === unavailable.id)!.profileId =
      "missing-shell";
    state.orderByProject[0]!.terminalIds = [
      unavailable.id,
      terminal.id,
      terminal.id,
    ];
    await first.manager.close();

    const second = setup();
    try {
      await second.manager.restoreState(state);
      expect(second.spawns).toHaveLength(0);
      expect(second.manager.list(process.cwd())).toMatchObject({
        terminals: [
          {
            id: unavailable.id,
            profileId: "missing-shell",
            shellLabel: "missing-shell",
            status: "exited",
          },
          {
            id: terminal.id,
            title: "Build shell",
            titleSource: "user",
            currentCwd: process.cwd(),
            status: "exited",
          },
        ],
        profiles: [
          { id: "bash", available: true },
          { id: "missing-shell", available: false },
        ],
      });
      await expect(
        second.manager.restart(unavailable.id),
      ).rejects.toMatchObject({
        code: "terminal_profile_unavailable",
        status: 400,
      });
      await second.manager.remove(unavailable.id, false);
      await expect(second.manager.restart(terminal.id)).resolves.toMatchObject({
        id: terminal.id,
        title: "Build shell",
        status: "running",
      });
      expect(second.spawns).toHaveLength(1);
    } finally {
      await second.manager.close();
    }
  });

  it("publishes neither a writer nor a new replay grid when PTY resize fails", async () => {
    const { manager, spawns } = setup();
    try {
      const terminal = await manager.create({ cwd: process.cwd() });
      const pty = spawns[0]!.pty;
      const sink = new FakeSink();
      const options = {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: 120,
        rows: 40,
      };
      const resize = vi.spyOn(pty, "resize");
      const rejectResize = () =>
        resize.mockImplementationOnce(() => {
          throw new Error("PTY resize failed");
        });

      rejectResize();
      await expect(manager.attach(options, sink)).rejects.toThrow(
        "PTY resize failed",
      );
      expect(manager.list().terminals[0]).toMatchObject({
        viewerCount: 0,
        hasOwner: false,
      });
      expect(sink.controls).toEqual([]);

      const writer = await manager.attach(options, sink);
      expect(attachedMessage(sink)).toMatchObject({ writable: true });
      pty.emitData("retained output");
      const before = manager.list().terminals[0]!;
      const delivered = sink.controls.length;
      const change = { type: "resize", cols: 130, rows: 45 } as const;
      rejectResize();
      expect(() => writer.control(change)).toThrow("PTY resize failed");
      expect(manager.list().terminals[0]).toMatchObject({
        cols: before.cols,
        rows: before.rows,
        resizeRevision: before.resizeRevision,
        firstOutputOffset: before.firstOutputOffset,
        nextOutputOffset: before.nextOutputOffset,
      });
      expect(
        sink.controls
          .slice(delivered)
          .some((message) => message.type === "resized"),
      ).toBe(false);

      writer.control(change);
      expect(pty.resizes.at(-1)).toEqual([130, 45]);
      expect(manager.list().terminals[0]).toMatchObject({
        cols: 130,
        rows: 45,
        viewerCount: 1,
        hasOwner: true,
      });
    } finally {
      await manager.close();
    }
  });

  it("retains the previous writer when takeover resize or delivery fails", async () => {
    const { manager, spawns } = setup();
    try {
      const terminal = await manager.create({ cwd: process.cwd() });
      const options = { terminalId: terminal.id, cols: 100, rows: 30 };
      const firstSink = new FakeSink();
      const first = await manager.attach(
        { ...options, clientId: "client-a" },
        firstSink,
      );
      const secondSink = new FakeSink();
      const nextOwner = { ...options, clientId: "client-b" };
      const second = await manager.attach(nextOwner, secondSink);
      const pty = spawns[0]!.pty;
      const takeover = { type: "take_control", cols: 120, rows: 40 } as const;
      vi.spyOn(pty, "resize").mockImplementationOnce(() => {
        throw new Error("PTY resize failed");
      });

      expect(() => second.control(takeover)).toThrow("PTY resize failed");
      first.writeInput(1, Buffer.from("after resize refusal\r"));
      expect(pty.writes.map(String)).toEqual(["after resize refusal\r"]);

      vi.spyOn(secondSink, "sendControl").mockImplementation(() => {
        throw new Error("socket closed during resize");
      });
      second.control(takeover);
      expect(manager.list().terminals[0]).toMatchObject({ viewerCount: 1 });
      first.writeInput(2, Buffer.from("after sink failure\r"));
      expect(pty.writes.map(String)).toEqual([
        "after resize refusal\r",
        "after sink failure\r",
      ]);
      expect(
        firstSink.controls.some(
          (message) => message.type === "ownership" && !message.writable,
        ),
      ).toBe(false);

      const retry = await manager.attach(nextOwner, new FakeSink());
      retry.control(takeover);
      retry.writeInput(1, Buffer.from("new owner\r"));
      expect(String(pty.writes.at(-1))).toBe("new owner\r");
    } finally {
      await manager.close();
    }
  });

  it.each([
    ["takeover", 30],
    ["reconnect", 30],
    ["reconnect with resize", 40],
  ] as const)(
    "releases the writer lease when both peers fail during %s",
    async (handoff, rows) => {
      const { manager } = setup(500);
      try {
        const terminal = await manager.create({ cwd: process.cwd() });
        const options = {
          terminalId: terminal.id,
          clientId: "client-a",
          cols: 100,
          rows: 30,
        };
        const first = new FakeSink();
        await manager.attach(options, first);
        const second = new FakeSink();
        const contender =
          handoff === "takeover"
            ? await manager.attach({ ...options, clientId: "client-b" }, second)
            : null;
        for (const sink of [first, second]) {
          vi.spyOn(sink, "sendControl").mockImplementation(() => {
            throw new Error("writer disconnected");
          });
        }
        vi.useFakeTimers();

        if (contender)
          contender.control({ type: "take_control", cols: 100, rows });
        else {
          const ownerToken = attachedMessage(first)!.ownerToken;
          await expect(
            manager.attach({ ...options, ownerToken, rows }, second),
          ).rejects.toMatchObject({ code: "attachment_closed" });
        }
        await vi.advanceTimersByTimeAsync(501);
        expect(manager.list().terminals[0]).toMatchObject({
          viewerCount: 0,
          hasOwner: false,
        });
      } finally {
        vi.useRealTimers();
        await manager.close();
      }
    },
  );

  it("tracks shell command boundaries, working directories, and completion", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    const sink = new FakeSink();
    await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: 100,
        rows: 30,
      },
      sink,
    );

    const exactCommand = "printf 'a  b'";
    spawns[0]?.pty.emitData(
      `\u001b]6973;C1;${encodeURIComponent(exactCommand)}\u0007`,
    );
    await vi.waitFor(() =>
      expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
        currentCommand: "printf 'a b'",
        commandRunning: true,
      }),
    );
    const commandCwd = `${process.cwd()}/path  with spaces`;
    spawns[0]?.pty.emitData(
      `\u001b]6973;P1;${encodeURIComponent(commandCwd)}\u0007\u001b]6973;D;0\u0007`,
    );
    await vi.waitFor(() =>
      expect(
        sink.controls.find((message) => message.type === "command_complete"),
      ).toMatchObject({
        type: "command_complete",
        command: exactCommand,
        currentCwd: commandCwd,
        exitCode: 0,
      }),
    );
    expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
      currentCommand: "bash",
      commandRunning: false,
      title: "Bash",
    });
    await manager.close();
  });

  it("replays output after a slow writer disconnects and keeps the same tab through exit and restart", async () => {
    const { manager, spawns } = setup();
    try {
      const terminal = await manager.create({ cwd: process.cwd() });
      const pty = spawns[0]!.pty;
      const options = {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: terminal.cols,
        rows: terminal.rows,
      };
      pty.emitData("first\r\n");
      const snapshot = new FakeSink();
      await manager.attach(options, snapshot);
      const attached = attachedMessage(snapshot);
      expect(attached).toMatchObject({ replay: "snapshot", writable: true });
      expect(
        snapshot.frames.map(
          (frame) => decodeTerminalServerDataFrame(frame).kind,
        ),
      ).toContain("snapshot");

      snapshot.failData = true;
      pty.emitData("second\r\n");
      expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
        viewerCount: 0,
        hasOwner: true,
      });
      const delta = new FakeSink();
      const resumed = await manager.attach(
        {
          ...options,
          outputEpoch: terminal.outputEpoch,
          resizeRevision: terminal.resizeRevision,
          nextOutputOffset: Buffer.byteLength("first\r\n"),
          ownerToken: attached?.ownerToken,
        },
        delta,
      );
      expect(attachedMessage(delta)).toMatchObject({
        replay: "delta",
        writable: true,
      });
      const replay = delta.frames.map(
        (frame) => decodeTerminalServerDataFrame(frame).data,
      );
      expect(Buffer.concat(replay).toString()).toBe("second\r\n");
      resumed.writeInput(1, Buffer.from("reclaimed\r"));
      expect(pty.writes.map(String)).toEqual(["reclaimed\r"]);

      pty.emitExit(7, 0);
      expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
        status: "exited",
        exitCode: 7,
        hasOwner: false,
      });
      const exited = new FakeSink();
      await manager.attach(options, exited);
      expect(attachedMessage(exited)).toMatchObject({
        replay: "snapshot",
        writable: false,
      });
      expect(
        Buffer.concat(
          exited.frames.map(
            (frame) => decodeTerminalServerDataFrame(frame).data,
          ),
        ).toString(),
      ).toContain("second");
      const restarted = await manager.restart(terminal.id);
      expect(restarted).toMatchObject({
        id: terminal.id,
        status: "running",
        exitCode: null,
      });
      expect(restarted.outputEpoch).not.toBe(terminal.outputEpoch);
      expect(exited.closes).toContainEqual([1012, "Terminal restarted"]);
      expect(spawns).toHaveLength(2);

      await manager.remove(terminal.id, false);
      expect(manager.list(process.cwd()).terminals).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  it("uses a platform-valid native PTY kill when tree termination fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-pty-fallback-"));
    const nativePty = createRequire(import.meta.url)(
      "@lydell/node-pty",
    ) as typeof import("@lydell/node-pty");
    const pty = new FakePty();
    // A live POSIX birth is required even for a failed-group fallback. No
    // actual signal is sent: the native adapter is fake and kill is mocked.
    // Windows uses a nonexistent taskkill path to exercise native ConPTY close.
    Object.defineProperty(pty, "pid", {
      value: process.platform === "win32" ? 2_147_483_647 : process.pid,
    });
    const signal = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, value) => {
        if (pid === pty.pid) {
          pty.kill(value as string);
          return true;
        }
        throw Object.assign(new Error("No such group"), { code: "ESRCH" });
      });
    const kill = vi.spyOn(pty, "kill");
    const spawn = vi.spyOn(nativePty, "spawn").mockReturnValue(pty as never);
    const manager = new TerminalSessionManager({
      profiles: [
        {
          id: "test",
          label: "Test shell",
          shell: "test-shell",
          args: [],
          available: true,
          isDefault: true,
        },
      ],
      env: { ...process.env, SystemRoot: directory },
    });
    try {
      const terminal = await manager.create({ cwd: directory });
      await manager.remove(terminal.id, true);
      expect(kill.mock.calls).toEqual(
        process.platform === "win32" ? [[]] : [["SIGKILL"]],
      );
      expect(manager.list().terminals).toEqual([]);
    } finally {
      pty.emitExit(0);
      await manager.close();
      spawn.mockRestore();
      signal.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the terminal if the PTY cannot be stopped after force-close", async () => {
    vi.useFakeTimers();
    const { manager, spawns } = setup();
    try {
      const terminal = await manager.create({ cwd: process.cwd() });
      vi.spyOn(spawns[0]!.pty, "kill").mockImplementation(() => {});
      const rejected = expect(
        manager.remove(terminal.id, true),
      ).rejects.toMatchObject({
        code: "terminal_stop_timeout",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(manager.list().terminals.map(({ id }) => id)).toEqual([
        terminal.id,
      ]);
    } finally {
      spawns[0]?.pty.emitExit(0);
      await manager.close();
      vi.useRealTimers();
    }
  });

  it.each(["signal", "confirmation"] as const)(
    "retains failed descendant %s cleanup after root exit for an explicit retry",
    async (failure) => {
      const { manager, spawns } = setup();
      const terminal = await manager.create({ cwd: process.cwd() });
      const pty = spawns[0]!.pty;
      let fail = true;
      const killTree = vi.fn(async (signal: string) => {
        if (signal === "SIGHUP") pty.emitExit(0);
        else if (failure === "signal" && fail)
          throw new Error("permission denied");
      });
      const waitForTreeExit = vi.fn(async () => !fail);
      Object.assign(pty, { killTree, waitForTreeExit });
      try {
        await expect(manager.remove(terminal.id, false)).rejects.toMatchObject({
          code: "terminal_cleanup_failed",
          status: 503,
        });
        expect(manager.list().terminals).toEqual([
          expect.objectContaining({
            id: terminal.id,
            status: "exited",
          }),
        ]);
        fail = false;
        await manager.remove(terminal.id, false);
        expect(killTree.mock.calls).toEqual([
          ["SIGHUP"],
          ["SIGKILL"],
          ["SIGKILL"],
        ]);
        expect(waitForTreeExit).toHaveBeenCalled();
        expect(manager.list().terminals).toHaveLength(0);
      } finally {
        fail = false;
        pty.emitExit(0);
        await manager.close();
      }
    },
  );

  it("waits for PTY drain and shares its hard-stop budget with descendant cleanup", async () => {
    vi.useFakeTimers();
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    const pty = spawns[0]!.pty;
    const waitForTreeExit = vi.fn(async () => true);
    Object.assign(pty, {
      killTree: vi.fn(async () => {
        setTimeout(() => pty.emitExit(0), 1_500);
      }),
      waitForTreeExit,
    });
    try {
      const removing = manager.remove(terminal.id, true);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(manager.list().terminals.map(({ id }) => id)).toEqual([
        terminal.id,
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(removing).resolves.toMatchObject({
        catalogEpoch: terminal.catalogEpoch,
      });
      expect(manager.list().terminals).toEqual([]);
      expect(waitForTreeExit).toHaveBeenCalledExactlyOnceWith(3_500);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pty.emitExit(0);
      await manager.close();
      vi.useRealTimers();
    }
  });

  it.each(["create", "restart"] as const)(
    "fences a pending %s when terminal-service shutdown begins",
    async (action) => {
      const { manager, spawns } = setup();
      const initial =
        action === "restart"
          ? await manager.create({ cwd: process.cwd() })
          : undefined;
      const mutating = initial
        ? manager.restart(initial.id)
        : manager.create({ cwd: process.cwd() });
      const fenced = expect(mutating).rejects.toMatchObject({
        code: "service_closing",
        status: 503,
      });
      if (!initial) manager.prepareShutdown(false);
      await manager.close();
      await fenced;
      expect(spawns).toHaveLength(initial ? 1 : 0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "retires a detached HUP-resistant descendant after the native PTY root exits",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-detached-pty-tree-"),
      );
      const childPath = join(directory, "child.pid");
      const childCode = [
        'process.on("SIGHUP", () => {});',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
        "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 30_000);",
      ].join("\n");
      const rootCode = [
        'process.on("SIGHUP", () => process.exit(0));',
        'const child = require("node:child_process").spawn(process.execPath, ["-e", ' +
          JSON.stringify(childCode) +
          ', process.argv[1]], { detached: true, stdio: "ignore" });',
        "child.unref(); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 30_000);",
      ].join("\n");
      const manager = new TerminalSessionManager({
        profiles: [
          {
            id: "node-tree",
            label: "Owned process tree",
            shell: process.execPath,
            args: ["-e", rootCode, childPath],
            available: true,
            isDefault: true,
          },
        ],
      });
      let pid = 0;
      let birth: string | null = null;
      try {
        const terminal = await manager.create({ cwd: directory });
        await vi.waitFor(
          async () => {
            pid = Number(await readFile(childPath, "utf8"));
            expect(pid).toBeGreaterThan(1);
            birth = await terminalTreeInspector.identity(pid);
            expect(birth).not.toBeNull();
          },
          { timeout: 10_000 },
        );
        await manager.remove(terminal.id, false);
        expect(manager.list().terminals).toEqual([]);
        expect(await terminalTreeInspector.identity(pid)).toBeNull();
      } finally {
        await manager.close();
        if (birth && (await terminalTreeInspector.identity(pid)) === birth)
          process.kill(pid, "SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
