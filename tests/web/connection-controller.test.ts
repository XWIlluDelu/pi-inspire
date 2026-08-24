// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionController,
  FIRST_SNAPSHOT_TIMEOUT_MS,
  STREAM_INACTIVITY_TIMEOUT_MS,
} from "../../src/controllers/connection-controller";

class ImmediateCloseSocket {
  static instances: ImmediateCloseSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;

  constructor(readonly url: string) {
    ImmediateCloseSocket.instances.push(this);
  }

  close(): void {
    this.closeCount += 1;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const snapshot = {
  type: "snapshot",
  data: { active: null, runState: "idle", sessionStatuses: {} },
};
const controllers: ConnectionController[] = [];

function harness() {
  const host = {
    state: vi.fn(() => ({ bootstrapped: true })),
    patch: vi.fn(),
    applyEvent: vi.fn(),
    onTransportReplaced: vi.fn(),
    onTransportClosed: vi.fn(),
    reconnect: vi.fn(),
  };
  const controller = new ConnectionController(host);
  controllers.push(controller);
  return { controller, host };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  ImmediateCloseSocket.instances = [];
});

describe("ConnectionController", () => {
  it("detaches a replaced socket before an eager close callback can reconnect", () => {
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("first");
    const first = ImmediateCloseSocket.instances[0]!;
    controller.connect("second");

    expect(host.onTransportReplaced).toHaveBeenCalledOnce();
    expect(host.onTransportClosed).not.toHaveBeenCalled();
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(first.url).toContain("token=first");
  });

  it("backs off after an unexpected current-socket close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("retry-token");
    ImmediateCloseSocket.instances[0]!.onclose?.();

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(host.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.reconnect).toHaveBeenCalledWith("retry-token");
  });

  it("publishes open only after applying the authoritative first snapshot", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    expect(host.patch).not.toHaveBeenCalledWith({
      connection: "open",
      connectionProblem: null,
    });

    socket.emit(snapshot);
    expect(host.applyEvent).toHaveBeenCalledWith(snapshot);
    expect(host.patch).toHaveBeenLastCalledWith({
      connection: "open",
      connectionProblem: null,
    });

    socket.emit({ type: "heartbeat" });
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
  });

  it("abandons an open socket that never supplies its first snapshot", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(FIRST_SNAPSHOT_TIMEOUT_MS);

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(host.reconnect).toHaveBeenCalledWith("token");
  });

  it("resets its inactivity watchdog on valid heartbeat frames", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    vi.advanceTimersByTime(20_000);
    socket.emit({ type: "heartbeat" });
    vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS - 1);
    expect(host.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).toHaveBeenCalledWith("token");
  });

  it("keeps a recent stream on visibility return but rebuilds it on online", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    controller.recover("visible");
    expect(host.reconnect).not.toHaveBeenCalled();

    controller.recover("online");
    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).toHaveBeenCalledWith("token");
  });

  it("coalesces complete partial messages but flushes before lifecycle events", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    for (const text of ["a", "ab", "abc"]) {
      socket.emit({
        type: "message_update",
        sessionId: "session-a",
        message: {
          __inspireLiveId: "assistant-a",
          role: "assistant",
          content: text,
        },
      });
    }
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
    socket.emit({
      type: "message_end",
      sessionId: "session-a",
      message: {
        __inspireLiveId: "assistant-a",
        role: "assistant",
        content: "abc",
      },
    });

    expect(host.applyEvent).toHaveBeenCalledTimes(3);
    expect(host.applyEvent.mock.calls[1]![0]).toMatchObject({
      type: "message_update",
      message: { content: "abc" },
    });
    expect(host.applyEvent.mock.calls[2]![0]).toMatchObject({
      type: "message_end",
    });
  });

  it("releases the latest partial message on its render timer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    for (const text of ["a", "ab"]) {
      socket.emit({
        type: "message_update",
        sessionId: "session-a",
        message: {
          __inspireLiveId: "assistant-a",
          role: "assistant",
          content: text,
        },
      });
    }
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15);
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(host.applyEvent).toHaveBeenCalledTimes(2);
    expect(host.applyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "message_update",
        message: expect.objectContaining({ content: "ab" }),
      }),
    );
  });

  it("rebuilds from a snapshot when a live reducer rejects an event", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    host.applyEvent.mockImplementation((event: { type?: string }) => {
      if (event.type === "agent_start") throw new Error("invalid transition");
    });
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    socket.emit({ type: "agent_start", sessionId: "session-a" });

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(host.reconnect).toHaveBeenCalledWith("token");
  });
});
