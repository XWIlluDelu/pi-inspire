// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeTerminalInputFrame,
  encodeTerminalServerDataFrame,
  type TerminalDescriptor,
} from "../../shared/terminal-contracts.js";
import { TerminalConnection } from "../../src/terminal-connection.js";
import { terminalDescriptor } from "./fixtures/terminal-descriptor.js";

const terminal = terminalDescriptor("terminal-1", "/tmp/project", {
  catalogEpoch: "catalog-1",
  title: "Bash",
  outputEpoch: "epoch-1",
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly sockets: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<string | Uint8Array> = [];

  constructor() {
    super();
    FakeWebSocket.sockets.push(this);
  }

  send(value: string | Uint8Array): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED) this.disconnect();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function dataFrame(
  kind: Parameters<typeof encodeTerminalServerDataFrame>[0],
  offset = 0,
  bytes = new Uint8Array(),
): ArrayBuffer {
  const encoded = encodeTerminalServerDataFrame(kind, 0, offset, bytes);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

function attachForReplay(
  socket: FakeWebSocket,
  nextInputSequence = 1,
  attachedTerminal: TerminalDescriptor = terminal,
  ownerToken = "owner-token",
): void {
  socket.receive(
    JSON.stringify({
      type: "attached",
      terminal: attachedTerminal,
      attachmentId: "attachment-1",
      writable: true,
      ownerToken,
      nextInputSequence,
      replay: "snapshot",
    }),
  );
}

function completeReplay(socket: FakeWebSocket, nextOutputOffset = 0): void {
  socket.receive(JSON.stringify({ type: "replay_complete", nextOutputOffset }));
}

function makeReady(...args: Parameters<typeof attachForReplay>): void {
  const [socket] = args;
  attachForReplay(...args);
  socket.receive(dataFrame("snapshot"));
  completeReplay(socket);
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture() {
  const api = {
    terminalAttachTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  };
  const events = {
    dimensions: () => ({ cols: 80, rows: 24 }),
    data: vi.fn(),
    control: vi.fn(),
    status: vi.fn(),
    error: vi.fn(),
  };
  const connection = new TerminalConnection(
    api as never,
    terminal.id,
    events,
    "client-1",
  );
  return { api, events, connection };
}

function inputFrames(socket: FakeWebSocket) {
  return socket.sent
    .filter((value) => typeof value !== "string")
    .map((value) => {
      const { sequence, data } = decodeTerminalInputFrame(value);
      return [sequence, new TextDecoder().decode(data)];
    });
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
    vi.restoreAllMocks();
  });

  it.each(["ticket", "socket", "attach", "replay", "inactive"] as const)(
    "recovers a silent %s stall without waiting for close",
    async (phase) => {
      let finishTicket!: (value: { ticket: string }) => void;
      const {
        api,
        events: { status },
        connection,
      } = fixture();
      if (phase === "ticket")
        api.terminalAttachTicket.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishTicket = resolve;
            }),
        );
      connection.start();
      await nextTurn();
      const old = FakeWebSocket.sockets[0];
      if (phase === "attach" || phase === "replay" || phase === "inactive")
        old!.open();
      if (phase === "replay") {
        attachForReplay(old!);
        old!.receive(dataFrame("snapshot"));
        expect(status).not.toHaveBeenCalledWith("connected");
      }
      if (phase === "inactive") {
        makeReady(old!, 1);
        for (let index = 0; index < 4; index += 1) {
          await vi.advanceTimersByTimeAsync(10_000);
          expect(JSON.parse(String(old!.sent.at(-1)))).toEqual({
            type: "ping",
          });
          old!.receive(JSON.stringify({ type: "heartbeat" }));
        }
        expect(FakeWebSocket.sockets).toHaveLength(1);
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
      connection.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.terminalAttachTicket).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenLastCalledWith("offline");
    },
  );

  it("accepts chunked snapshots without advancing the raw output offset", async () => {
    const {
      events: { data, error },
      connection,
    } = fixture();
    connection.start();
    await nextTurn();
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    attachForReplay(socket, 1, { ...terminal, nextOutputOffset: 12 });
    for (const [kind, offset, bytes] of [
      ["snapshot", 10, Uint8Array.of(65)],
      ["snapshot-continuation", 10, Uint8Array.of(66)],
      ["output", 10, Uint8Array.of(67, 68)],
    ] as const)
      socket.receive(dataFrame(kind, offset, bytes));
    completeReplay(socket, 12);

    expect(data.mock.calls.map(([frame]) => frame.kind)).toEqual([
      "snapshot",
      "snapshot-continuation",
      "output",
    ]);
    expect(error).not.toHaveBeenCalled();
    connection.stop();
  });

  it.each([
    { reason: "daemon already accepted the input", next: 2 },
    { reason: "replacement PTY", outputEpoch: "epoch-2", next: 1 },
    { reason: "replacement owner", ownerToken: "replacement-token", next: 1 },
    {
      reason: "same owner without session storage",
      noStorage: true,
      next: 1,
      replay: true,
    },
    {
      reason: "replacement owner without session storage",
      noStorage: true,
      ownerToken: "replacement-token",
      next: 1,
    },
  ])(
    "scopes pending input during reconnect with $reason",
    async ({ next, outputEpoch, ownerToken, noStorage, replay }) => {
      if (noStorage) {
        const unavailable = () => {
          throw new Error("Storage is unavailable");
        };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(unavailable);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(unavailable);
      }
      const { connection } = fixture();
      connection.start();
      await nextTurn();
      const first = FakeWebSocket.sockets[0]!;
      first.open();
      makeReady(first, 1);
      try {
        expect(connection.sendInput("only once\r")).toBe(true);
        expect(inputFrames(first)).toEqual([[1, "only once\r"]]);
        first.disconnect();

        await vi.advanceTimersByTimeAsync(400);
        const current = FakeWebSocket.sockets[1]!;
        current.open();
        expect(JSON.parse(String(current.sent[0]))).toMatchObject({
          clientId: "client-1",
          ...(noStorage ? {} : { ownerToken: "owner-token" }),
        });
        makeReady(
          current,
          next,
          { ...terminal, outputEpoch: outputEpoch ?? terminal.outputEpoch },
          ownerToken,
        );
        const resent = replay ? [[1, "only once\r"]] : [];
        expect(inputFrames(current)).toEqual(resent);
        expect(connection.sendInput("new input\r")).toBe(true);
        expect(inputFrames(current)).toEqual([
          ...resent,
          [replay ? 2 : next, "new input\r"],
        ]);
      } finally {
        connection.stop();
      }
    },
  );
});
