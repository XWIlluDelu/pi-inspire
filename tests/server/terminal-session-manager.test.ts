import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TerminalAttachmentSink } from "../../server/terminal-service.js";
import {
  type TerminalPty,
  type TerminalPtyFactory,
  type TerminalPtySpawnOptions,
  TerminalSessionManager,
} from "../../server/terminal-session-manager.js";
import {
  decodeTerminalServerDataFrame,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts.js";

class FakePty implements TerminalPty {
  readonly pid = 1234;
  readonly process = "bash";
  readonly writes: Buffer[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly signals: Array<string | undefined> = [];
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

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  write(data: string | Buffer): void {
    this.writes.push(
      Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data),
    );
  }

  kill(signal?: string): void {
    this.signals.push(signal);
    this.emitExit(0, signal === "SIGKILL" ? 9 : 1);
  }

  emitData(data: string | Buffer): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

interface FakePtySpawn {
  shell: string;
  args: string[];
  options: TerminalPtySpawnOptions;
  pty: FakePty;
}

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
  const spawns: FakePtySpawn[] = [];
  let nextUuid = 0;
  const ptyFactory: TerminalPtyFactory = (shell, args, options) => {
    const pty = new FakePty();
    spawns.push({ shell, args, options, pty });
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
    uuid: () => `uuid-${++nextUuid}`,
    ownerReconnectGraceMs,
  });
  return { manager, spawns };
}

function attachedMessage(sink: FakeSink) {
  return sink.controls.find((message) => message.type === "attached");
}

describe("TerminalSessionManager", () => {
  it("creates a bounded project terminal with a server-owned profile", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
    });

    expect(terminal).toMatchObject({
      id: "uuid-1",
      profileId: "bash",
      status: "running",
      cols: 120,
      rows: 40,
    });
    expect(spawns[0]).toMatchObject({
      shell: "/bin/bash",
      args: ["-l"],
      options: { cwd: process.cwd(), cols: 120, rows: 40 },
    });
    expect(spawns[0]?.options.env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Inspire",
      INSPIRE_TERMINAL_ID: "uuid-1",
    });
    expect(manager.list(process.cwd()).terminals).toHaveLength(1);
    await expect(
      manager.create({ cwd: "relative/project" }),
    ).rejects.toMatchObject({ code: "invalid_cwd", status: 400 });
    await manager.close();
  });

  it("restores terminal tabs as exited metadata after a daemon restart", async () => {
    const first = setup();
    const terminal = await first.manager.create({ cwd: process.cwd() });
    await first.manager.rename(terminal.id, { title: "Build shell" });
    const state = first.manager.exportState();
    state.terminals[0]!.currentCwd = "relative/path\u001b]2;spoof";
    state.orderByProject[0]!.terminalIds = [terminal.id, terminal.id];
    await first.manager.close();

    const second = setup();
    await second.manager.restoreState(state);
    expect(second.manager.list(process.cwd()).terminals).toMatchObject([
      {
        id: terminal.id,
        title: "Build shell",
        titleSource: "user",
        currentCwd: process.cwd(),
        status: "exited",
      },
    ]);
    expect(second.spawns).toHaveLength(0);
    expect(second.manager.exportState().orderByProject[0]?.terminalIds).toEqual(
      [terminal.id],
    );

    await second.manager.restart(terminal.id);
    expect(second.spawns).toHaveLength(1);
    expect(second.manager.list(process.cwd()).terminals[0]).toMatchObject({
      id: terminal.id,
      title: "Build shell",
      status: "running",
    });
    await second.manager.close();
  });

  it("retains exited tabs whose shell profile is no longer available", async () => {
    const first = setup();
    const terminal = await first.manager.create({ cwd: process.cwd() });
    const state = first.manager.exportState();
    state.terminals[0]!.profileId = "missing-shell";
    await first.manager.close();

    const second = setup();
    await second.manager.restoreState(state);
    expect(second.manager.list(process.cwd())).toMatchObject({
      terminals: [
        {
          id: terminal.id,
          profileId: "missing-shell",
          shellLabel: "missing-shell",
          status: "exited",
        },
      ],
      profiles: [
        { id: "bash", available: true },
        { id: "missing-shell", available: false },
      ],
    });
    await expect(second.manager.restart(terminal.id)).rejects.toMatchObject({
      code: "terminal_profile_unavailable",
      status: 400,
    });
    await second.manager.remove(terminal.id, false);
    await second.manager.close();
  });

  it("grants one writer, deduplicates input, and supports explicit takeover", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    const firstSink = new FakeSink();
    const first = await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: 90,
        rows: 25,
      },
      firstSink,
    );
    const firstAttached = attachedMessage(firstSink);

    expect(firstSink.controls[0]).toMatchObject({ type: "attached" });
    expect(firstAttached).toMatchObject({
      type: "attached",
      writable: true,
      nextInputSequence: 1,
      replay: "snapshot",
    });
    first.writeInput(1, Buffer.from("echo one\r"));
    first.writeInput(1, Buffer.from("must not repeat"));
    expect(spawns[0]?.pty.writes.map(String)).toEqual(["echo one\r"]);
    expect(
      firstSink.controls.filter((message) => message.type === "input_ack"),
    ).toHaveLength(2);

    const secondSink = new FakeSink();
    const second = await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-b",
        cols: 130,
        rows: 50,
      },
      secondSink,
    );
    expect(attachedMessage(secondSink)).toMatchObject({ writable: false });
    second.writeInput(1, Buffer.from("blocked"));
    expect(spawns[0]?.pty.writes).toHaveLength(1);

    second.control({ type: "take_control", cols: 130, rows: 50 });
    expect(spawns[0]?.pty.resizes.at(-1)).toEqual([130, 50]);
    expect(
      firstSink.controls.find(
        (message) => message.type === "ownership" && message.reason === "taken",
      ),
    ).toMatchObject({ writable: false });
    second.writeInput(1, Buffer.from("echo two\r"));
    expect(spawns[0]?.pty.writes.map(String)).toEqual([
      "echo one\r",
      "echo two\r",
    ]);
    await manager.close();
  });

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

  it("replays retained raw bytes by offset and snapshots stale clients", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    spawns[0]?.pty.emitData(Buffer.from("first\r\n"));

    const snapshotSink = new FakeSink();
    const attachment = await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: terminal.cols,
        rows: terminal.rows,
      },
      snapshotSink,
    );
    expect(
      snapshotSink.frames.map(
        (frame) => decodeTerminalServerDataFrame(frame).kind,
      ),
    ).toContain("snapshot");
    const attached = attachedMessage(snapshotSink);
    expect(attached?.type).toBe("attached");

    attachment.detach();
    spawns[0]?.pty.emitData(Buffer.from("second\r\n"));
    const deltaSink = new FakeSink();
    await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: terminal.cols,
        rows: terminal.rows,
        outputEpoch: terminal.outputEpoch,
        resizeRevision: terminal.resizeRevision,
        nextOutputOffset: Buffer.byteLength("first\r\n"),
        ownerToken:
          attached?.type === "attached" ? attached.ownerToken : undefined,
      },
      deltaSink,
    );

    expect(attachedMessage(deltaSink)).toMatchObject({ replay: "delta" });
    const replayed = deltaSink.frames
      .map((frame) => decodeTerminalServerDataFrame(frame))
      .flatMap((frame) => [...frame.data]);
    expect(Buffer.from(replayed).toString()).toBe("second\r\n");
    await manager.close();
  });

  it("detaches a viewer whose output sink rejects backpressure", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    const sink = new FakeSink();
    await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: terminal.cols,
        rows: terminal.rows,
      },
      sink,
    );

    sink.failData = true;
    spawns[0]?.pty.emitData("overflow");
    expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
      viewerCount: 0,
      hasOwner: true,
    });
    await manager.close();
  });

  it("keeps exited output available and restarts the same tab identity", async () => {
    const { manager, spawns } = setup();
    const terminal = await manager.create({ cwd: process.cwd() });
    const sink = new FakeSink();
    await manager.attach(
      {
        terminalId: terminal.id,
        clientId: "client-a",
        cols: terminal.cols,
        rows: terminal.rows,
      },
      sink,
    );
    spawns[0]?.pty.emitExit(7, 0);

    expect(manager.list(process.cwd()).terminals[0]).toMatchObject({
      status: "exited",
      exitCode: 7,
      hasOwner: false,
    });
    const restarted = await manager.restart(terminal.id);
    expect(restarted).toMatchObject({
      id: terminal.id,
      status: "running",
      exitCode: null,
    });
    expect(restarted.outputEpoch).not.toBe(terminal.outputEpoch);
    expect(sink.closes).toContainEqual([1012, "Terminal restarted"]);
    expect(spawns).toHaveLength(2);

    await manager.remove(terminal.id, false);
    expect(manager.list(process.cwd()).terminals).toEqual([]);
    await manager.close();
  });

  it("holds a disconnected writer lease briefly for lossless reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup(500);
      const terminal = await manager.create({ cwd: process.cwd() });
      const firstSink = new FakeSink();
      const first = await manager.attach(
        {
          terminalId: terminal.id,
          clientId: "client-a",
          cols: terminal.cols,
          rows: terminal.rows,
        },
        firstSink,
      );
      const firstAttached = attachedMessage(firstSink);
      first.detach();

      const reconnectSink = new FakeSink();
      await manager.attach(
        {
          terminalId: terminal.id,
          clientId: "client-a",
          cols: terminal.cols,
          rows: terminal.rows,
          ownerToken:
            firstAttached?.type === "attached"
              ? firstAttached.ownerToken
              : undefined,
        },
        reconnectSink,
      );
      expect(attachedMessage(reconnectSink)).toMatchObject({ writable: true });

      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a platform-valid native PTY kill when tree termination fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-pty-fallback-"));
    const nativePty = createRequire(import.meta.url)(
      "@lydell/node-pty",
    ) as typeof import("@lydell/node-pty");
    const pty = new FakePty();
    // No live POSIX process/group can have this PID. On Windows the empty
    // SystemRoot guarantees taskkill cannot start, exercising its fallback.
    Object.defineProperty(pty, "pid", { value: 2_147_483_647 });
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
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "waits for PTY output drain before removing a terminal (force=%s)",
    async (force) => {
      vi.useFakeTimers();
      const { manager, spawns } = setup();
      let pty: FakePty | undefined;
      try {
        const terminal = await manager.create({ cwd: process.cwd() });
        pty = spawns[0]!.pty;
        const delayedPty = pty;
        vi.spyOn(pty, "kill").mockImplementation((signal) => {
          delayedPty.signals.push(signal);
          if (signal === "SIGKILL") {
            // ConPTY delays onExit while draining output after process exit.
            setTimeout(() => delayedPty.emitExit(0), 1_500);
          }
        });
        let settled = false;
        const removing = manager.remove(terminal.id, force).then(
          (receipt) => {
            settled = true;
            return receipt;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await vi.advanceTimersByTimeAsync(force ? 1_200 : 3_200);
        expect(settled).toBe(false);
        expect(manager.list().terminals).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(300);
        await expect(removing).resolves.toMatchObject({
          catalogEpoch: terminal.catalogEpoch,
          revision: expect.any(Number),
        });
        expect(manager.list().terminals).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        pty?.emitExit(0);
        await manager.close();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "retains a terminal when its PTY cannot be stopped (force=%s)",
    async (force) => {
      vi.useFakeTimers();
      const { manager, spawns } = setup();
      let pty: FakePty | undefined;
      try {
        const terminal = await manager.create({ cwd: process.cwd() });
        pty = spawns[0]!.pty;
        vi.spyOn(pty, "kill").mockImplementation(() => {});
        const removing = manager.remove(terminal.id, force);
        const rejected = expect(removing).rejects.toMatchObject({
          code: "terminal_stop_timeout",
        });
        await vi.advanceTimersByTimeAsync(force ? 5_000 : 7_000);
        await rejected;
        expect(manager.list().terminals).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        pty?.emitExit(0);
        await manager.close();
        vi.useRealTimers();
      }
    },
  );

  it("does not spawn new PTYs after terminal-service shutdown begins", async () => {
    const first = setup();
    const creating = first.manager.create({ cwd: process.cwd() });
    await first.manager.close();
    await expect(creating).rejects.toMatchObject({
      code: "service_closing",
      status: 503,
    });
    expect(first.spawns).toHaveLength(0);

    const second = setup();
    const terminal = await second.manager.create({ cwd: process.cwd() });
    const restarting = second.manager.restart(terminal.id);
    await second.manager.close();
    await expect(restarting).rejects.toMatchObject({
      code: "service_closing",
      status: 503,
    });
    expect(second.spawns).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")(
    "kills HUP-resistant descendants when a terminal closes",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-pty-tree-"));
      const childPidPath = join(directory, "child.pid");
      const manager = new TerminalSessionManager({
        profiles: [
          {
            id: "sh",
            label: "Shell",
            shell: "/bin/sh",
            // Start the fixture through argv, not interactive input sent before
            // macOS has finished initializing its PTY/shell. Publish readiness
            // only after the child has installed its HUP disposition.
            args: [
              "-c",
              'sh -c \'trap "" HUP; printf "%s" "$$" > "$1"; exec sleep 600\' sh "$1" & wait',
              "inspire-tree-test",
              childPidPath,
            ],
            available: true,
            isDefault: true,
          },
        ],
      });
      let childPid = 0;
      try {
        const terminal = await manager.create({ cwd: directory });
        await vi.waitFor(
          async () => {
            childPid = Number(await readFile(childPidPath, "utf8"));
            expect(childPid).toBeGreaterThan(1);
            expect(() => process.kill(childPid, 0)).not.toThrow();
          },
          { timeout: 10_000 },
        );

        await manager.remove(terminal.id, false);
        await vi.waitFor(() =>
          expect(() => process.kill(childPid, 0)).toThrow(),
        );
      } finally {
        await manager.close();
        if (childPid > 1) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // A correctly stopped process tree is already gone.
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
