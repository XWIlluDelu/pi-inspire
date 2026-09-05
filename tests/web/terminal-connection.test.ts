// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeTerminalInputFrame,
  encodeTerminalServerDataFrame,
  type TerminalDescriptor,
} from "../../shared/terminal-contracts.js";
import { TerminalConnection } from "../../src/terminal-connection.js";

const terminal: TerminalDescriptor = {
  catalogEpoch: "catalog-1",
  catalogRevision: 1,
  id: "terminal-1",
  projectCwd: "/tmp/project",
  title: "Bash",
  titleSource: "automatic",
  profileId: "bash",
  shellLabel: "Bash",
  currentCwd: "/tmp/project",
  currentCommand: "bash",
  commandRunning: false,
  status: "running",
  exitCode: null,
  signal: null,
  cols: 80,
  rows: 24,
  resizeRevision: 0,
  outputEpoch: "epoch-1",
  firstOutputOffset: 0,
  nextOutputOffset: 0,
  viewerCount: 1,
  hasOwner: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly sockets: FakeWebSocket[] = [];

  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  private readonly listeners = new Map<
    string,
    Set<(event: { data?: unknown }) => void>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function snapshotFrame(): ArrayBuffer {
  const encoded = encodeTerminalServerDataFrame(
    "snapshot",
    0,
    0,
    new Uint8Array(),
  );
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

function makeReady(
  socket: FakeWebSocket,
  nextInputSequence: number,
  attachedTerminal: TerminalDescriptor = terminal,
): void {
  socket.receive(
    JSON.stringify({
      type: "attached",
      terminal: attachedTerminal,
      attachmentId: "attachment-1",
      writable: true,
      ownerToken: "owner-token",
      nextInputSequence,
      replay: "snapshot",
    }),
  );
  socket.receive(snapshotFrame());
  socket.receive(
    JSON.stringify({ type: "replay_complete", nextOutputOffset: 0 }),
  );
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.sockets.length = 0;
    sessionStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["ticket", "socket", "attach", "replay", "inactive"] as const)(
    "recovers a silent %s stall without waiting for close",
    async (phase) => {
      let finishTicket!: (value: { ticket: string }) => void;
      const api = {
        terminalAttachTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
      };
      if (phase === "ticket")
        api.terminalAttachTicket.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishTicket = resolve;
            }),
        );
      const status = vi.fn();
      const connection = new TerminalConnection(
        api as never,
        terminal.id,
        {
          dimensions: () => ({ cols: 80, rows: 24 }),
          data: vi.fn(),
          control: vi.fn(),
          status,
          error: vi.fn(),
        },
        "client-1",
      );
      connection.start();
      await nextTurn();
      const old = FakeWebSocket.sockets[0];
      if (phase === "attach" || phase === "replay" || phase === "inactive")
        old!.open();
      if (phase === "replay") {
        old!.receive(
          JSON.stringify({
            type: "attached",
            terminal,
            writable: true,
            replay: "snapshot",
            nextInputSequence: 1,
          }),
        );
        old!.receive(snapshotFrame());
        expect(status).not.toHaveBeenCalledWith("connected");
      }
      if (phase === "inactive") {
        makeReady(old!, 1);
        connection.sendInput("once\r");
      }
      // A dead transport is allowed never to deliver its close event.
      if (old) vi.spyOn(old, "close").mockImplementation(() => {});
      await vi.advanceTimersByTimeAsync(
        (phase === "replay" || phase === "inactive" ? 30_000 : 10_000) + 400,
      );
      expect(api.terminalAttachTicket).toHaveBeenCalledTimes(2);
      if (phase === "ticket") {
        expect(api.terminalAttachTicket.mock.calls[0]![1].aborted).toBe(true);
        finishTicket({ ticket: "stale" });
        await nextTurn();
        expect(FakeWebSocket.sockets).toHaveLength(1);
      }
      const current = FakeWebSocket.sockets.at(-1)!;
      current.open();
      const attach = JSON.parse(String(current.sent[0]));
      if (phase === "replay") expect(attach.nextOutputOffset).toBeUndefined();
      if (phase === "inactive") expect(attach.nextOutputOffset).toBe(0);
      makeReady(current, phase === "inactive" ? 2 : 1);
      // A stale close must not revoke the new connection's writer state.
      old?.disconnect();
      expect(connection.sendInput("new\r")).toBe(true);
      // jsdom queues zero-delay storage events when the owner token changes.
      // Let that DOM work settle before checking transport-owned cleanup.
      await vi.advanceTimersByTimeAsync(0);
      connection.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.terminalAttachTicket).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenLastCalledWith("offline");
    },
  );

  it("keeps an idle shell alive with application ping/heartbeat", async () => {
    const connection = new TerminalConnection(
      {
        terminalAttachTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
      } as never,
      terminal.id,
      {
        dimensions: () => ({ cols: 80, rows: 24 }),
        data: vi.fn(),
        control: vi.fn(),
        status: vi.fn(),
        error: vi.fn(),
      },
      "client-1",
    );
    connection.start();
    await nextTurn();
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    makeReady(socket, 1);
    for (let index = 0; index < 12; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(JSON.parse(String(socket.sent.at(-1)))).toEqual({ type: "ping" });
      socket.receive(JSON.stringify({ type: "heartbeat" }));
    }
    expect(FakeWebSocket.sockets).toHaveLength(1);
    connection.stop();
  });

  it("accepts chunked snapshots without advancing the raw output offset", async () => {
    const data = vi.fn();
    const error = vi.fn();
    const api = {
      terminalAttachTicket: vi
        .fn()
        .mockResolvedValue({ ticket: "ticket", expiresAt: "later" }),
    };
    const connection = new TerminalConnection(
      api as never,
      terminal.id,
      {
        dimensions: () => ({ cols: 80, rows: 24 }),
        data,
        control: vi.fn(),
        status: vi.fn(),
        error,
      },
      "client-1",
    );

    connection.start();
    await nextTurn();
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    socket.receive(
      JSON.stringify({
        type: "attached",
        terminal: { ...terminal, nextOutputOffset: 12 },
        attachmentId: "attachment-1",
        writable: true,
        ownerToken: "owner-token",
        nextInputSequence: 1,
        replay: "snapshot",
      }),
    );
    for (const [kind, offset, bytes] of [
      ["snapshot", 10, Uint8Array.of(65)],
      ["snapshot-continuation", 10, Uint8Array.of(66)],
      ["output", 10, Uint8Array.of(67, 68)],
    ] as const) {
      const frame = encodeTerminalServerDataFrame(kind, 0, offset, bytes);
      socket.receive(
        frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
        ) as ArrayBuffer,
      );
    }
    socket.receive(
      JSON.stringify({ type: "replay_complete", nextOutputOffset: 12 }),
    );

    expect(data.mock.calls.map(([frame]) => frame.kind)).toEqual([
      "snapshot",
      "snapshot-continuation",
      "output",
    ]);
    expect(error).not.toHaveBeenCalled();
    connection.stop();
  });

  it("does not repeat input the daemon already accepted before reconnect", async () => {
    const api = {
      terminalAttachTicket: vi
        .fn()
        .mockResolvedValue({ ticket: "ticket", expiresAt: "later" }),
    };
    const connection = new TerminalConnection(
      api as never,
      terminal.id,
      {
        dimensions: () => ({ cols: 80, rows: 24 }),
        data: vi.fn(),
        control: vi.fn(),
        status: vi.fn(),
        error: vi.fn(),
      },
      "client-1",
    );

    connection.start();
    await nextTurn();
    const first = FakeWebSocket.sockets[0]!;
    first.open();
    makeReady(first, 1);
    expect(connection.sendInput("echo once\r")).toBe(true);
    const firstInput = first.sent.find((value) => typeof value !== "string");
    expect(decodeTerminalInputFrame(firstInput as Uint8Array)).toMatchObject({
      sequence: 1,
    });

    first.disconnect();
    await vi.advanceTimersByTimeAsync(400);
    await nextTurn();
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    const attach = JSON.parse(String(second.sent[0]));
    expect(attach).toMatchObject({
      ownerToken: "owner-token",
      clientId: "client-1",
    });
    makeReady(second, 2);
    expect(
      second.sent.filter((value) => typeof value !== "string"),
    ).toHaveLength(0);

    expect(connection.sendInput("echo twice\r")).toBe(true);
    const secondInput = second.sent.find((value) => typeof value !== "string");
    expect(decodeTerminalInputFrame(secondInput as Uint8Array)).toMatchObject({
      sequence: 2,
    });
    connection.stop();
  });

  it("does not replay pending input into a replacement PTY epoch", async () => {
    const api = {
      terminalAttachTicket: vi
        .fn()
        .mockResolvedValue({ ticket: "ticket", expiresAt: "later" }),
    };
    const connection = new TerminalConnection(
      api as never,
      terminal.id,
      {
        dimensions: () => ({ cols: 80, rows: 24 }),
        data: vi.fn(),
        control: vi.fn(),
        status: vi.fn(),
        error: vi.fn(),
      },
      "client-1",
    );

    connection.start();
    await nextTurn();
    const first = FakeWebSocket.sockets[0]!;
    first.open();
    makeReady(first, 1);
    connection.sendInput("old process input\r");
    first.disconnect();

    await vi.advanceTimersByTimeAsync(400);
    await nextTurn();
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    makeReady(second, 1, { ...terminal, outputEpoch: "epoch-2" });
    expect(
      second.sent.filter((value) => typeof value !== "string"),
    ).toHaveLength(0);

    expect(connection.sendInput("new process input\r")).toBe(true);
    const sent = second.sent.find((value) => typeof value !== "string");
    expect(decodeTerminalInputFrame(sent as Uint8Array).sequence).toBe(1);
    connection.stop();
  });

  it("resends unacknowledged input when the daemon still expects it", async () => {
    const api = {
      terminalAttachTicket: vi
        .fn()
        .mockResolvedValue({ ticket: "ticket", expiresAt: "later" }),
    };
    const connection = new TerminalConnection(
      api as never,
      terminal.id,
      {
        dimensions: () => ({ cols: 80, rows: 24 }),
        data: vi.fn(),
        control: vi.fn(),
        status: vi.fn(),
        error: vi.fn(),
      },
      "client-1",
    );

    connection.start();
    await nextTurn();
    const first = FakeWebSocket.sockets[0]!;
    first.open();
    makeReady(first, 1);
    connection.sendInput("only once\r");
    first.disconnect();

    await vi.advanceTimersByTimeAsync(400);
    await nextTurn();
    const second = FakeWebSocket.sockets[1]!;
    second.open();
    makeReady(second, 1);
    const resent = second.sent.find((value) => typeof value !== "string");
    const decoded = decodeTerminalInputFrame(resent as Uint8Array);
    expect(decoded.sequence).toBe(1);
    expect(new TextDecoder().decode(decoded.data)).toBe("only once\r");
    connection.stop();
  });
});
