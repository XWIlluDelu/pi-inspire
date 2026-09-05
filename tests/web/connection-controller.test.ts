// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../../shared/assistant-stream";
import {
  ConnectionController,
  FIRST_SNAPSHOT_TIMEOUT_MS,
  STREAM_INACTIVITY_TIMEOUT_MS,
} from "../../src/controllers/connection-controller";

class ImmediateCloseSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  static instances: ImmediateCloseSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  extensions = "";
  closeCount = 0;

  constructor(readonly url: string) {
    ImmediateCloseSocket.instances.push(this);
  }

  close(): void {
    this.closeCount += 1;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const authorityId = "11111111-1111-4111-8111-111111111111";
const snapshotDigest = "a".repeat(64);
const snapshot = {
  type: "snapshot",
  authorityId,
  snapshotDigest,
  data: { active: null, runState: "idle", sessionStatuses: {} },
};
const controllers: ConnectionController[] = [];

function harness() {
  const host = {
    state: vi.fn(() => ({
      bootstrapped: true,
      authorityId,
      snapshotDigest,
      sessionId: null as string | null,
    })),
    patch: vi.fn(),
    applyEvent: vi.fn(),
    recordSnapshotDigest: vi.fn(),
    invalidateSnapshotDigest: vi.fn(),
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
  it("keeps socket-local interest through selection, stale snapshots, and resume", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const state = { ...host.state(), sessionId: "a" as string | null };
    host.state.mockImplementation(() => state);
    controller.connect(null);
    const socket = ImmediateCloseSocket.instances[0];
    expect(new URL(socket.url).searchParams.get("detail")).toBe("a");
    socket.open();
    state.sessionId = "b";
    controller.updateDetailInterest();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "detail_interest",
      sessionId: "b",
      revision: 1,
    });
    socket.emit({ ...snapshot, detailSessionId: "a", detailRevision: 0 });
    expect(host.applyEvent).not.toHaveBeenCalled();
    const confirmed = { ...snapshot, detailSessionId: "b", detailRevision: 1 };
    socket.emit(confirmed);
    expect(host.applyEvent).toHaveBeenCalledWith(confirmed);
    state.sessionId = null;
    controller.updateDetailInterest();
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "detail_interest",
      sessionId: null,
      revision: 2,
    });
    socket.emit({ ...snapshot, detailSessionId: null, detailRevision: 2 });
    expect(socket.closeCount).toBe(0);
    socket.close();
    vi.advanceTimersByTime(1_000);
    expect(
      new URL(ImmediateCloseSocket.instances[1].url).searchParams.get("detail"),
    ).toBe("");
    expect(host.reconnect).not.toHaveBeenCalled();
  });

  it("sends a selection committed while the handshake was still connecting", () => {
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const state = { ...host.state() };
    host.state.mockImplementation(() => state);
    controller.connect(null);
    state.sessionId = "new-owner";
    controller.updateDetailInterest();
    const socket = ImmediateCloseSocket.instances[0];
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      sessionId: "new-owner",
      revision: 1,
    });
  });

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

  it("tries one lightweight resume before falling back to bootstrap", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("retry-token");
    ImmediateCloseSocket.instances[0]!.onclose?.();

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);

    ImmediateCloseSocket.instances[1]!.onclose?.();
    vi.advanceTimersByTime(1_999);
    expect(host.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.reconnect).toHaveBeenCalledWith("retry-token");
  });

  it("opens from an unchanged runtime snapshot after applying its out-of-band witness", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    ImmediateCloseSocket.instances[0]!.emit({
      type: "snapshot",
      authorityId,
      snapshotDigest,
      unchanged: true,
    });

    expect(host.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "snapshot", unchanged: true }),
    );
    expect(host.recordSnapshotDigest).toHaveBeenCalledWith(snapshotDigest);
    expect(host.patch).toHaveBeenLastCalledWith({
      connection: "open",
      connectionProblem: null,
    });
  });

  it("keeps Host-wide update events outside the runtime snapshot digest", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.emit(snapshot);
    host.invalidateSnapshotDigest.mockClear();
    host.applyEvent.mockClear();

    socket.emit({ type: "update_status", updateStatus: { revision: 1 } });
    expect(host.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "update_status" }),
    );
    expect(host.invalidateSnapshotDigest).not.toHaveBeenCalled();
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

  it("bounds a connection attempt that never supplies its first snapshot", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    vi.advanceTimersByTime(FIRST_SNAPSHOT_TIMEOUT_MS);

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(host.reconnect).not.toHaveBeenCalled();
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
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(ImmediateCloseSocket.instances[1]?.url).toContain(
      `snapshot=${snapshotDigest}`,
    );
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
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
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

  it("merges ordered delta batches and flushes them before lifecycle events", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    socket.emit({
      type: "message_update_batch",
      sessionId: "session-a",
      streamMessageKey: "live:assistant-a",
      streamTextLength: 1,
      assistantMessageEvents: [{ type: "text_delta", delta: "a" }],
    });
    socket.emit({
      type: "message_update_batch",
      sessionId: "session-a",
      streamMessageKey: "live:assistant-a",
      streamTextLength: 2,
      assistantMessageEvents: [{ type: "text_delta", delta: "b" }],
    });
    expect(host.applyEvent).toHaveBeenCalledTimes(1);

    socket.emit({ type: "agent_end", sessionId: "session-a" });
    expect(host.applyEvent).toHaveBeenCalledTimes(3);
    expect(host.applyEvent.mock.calls[1]![0]).toMatchObject({
      type: "message_update_batch",
      streamTextLength: 2,
      assistantMessageEvents: [
        { type: "text_delta", delta: "a" },
        { type: "text_delta", delta: "b" },
      ],
    });
    expect(host.applyEvent.mock.calls[2]![0]).toMatchObject({
      type: "agent_end",
    });
  });

  it("publishes a bounded delta batch before retaining its continuation", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    socket.emit({
      type: "message_update_batch",
      sessionId: "session-a",
      streamMessageKey: "live:assistant-a",
      streamTextLength: MAX_ASSISTANT_STREAM_BATCH_EVENTS,
      assistantMessageEvents: Array.from(
        { length: MAX_ASSISTANT_STREAM_BATCH_EVENTS },
        () => ({ type: "text_delta", delta: "a" }),
      ),
    });
    socket.emit({
      type: "message_update_batch",
      sessionId: "session-a",
      streamMessageKey: "live:assistant-a",
      streamTextLength: MAX_ASSISTANT_STREAM_BATCH_EVENTS + 1,
      assistantMessageEvents: [{ type: "text_delta", delta: "b" }],
    });

    expect(host.applyEvent).toHaveBeenCalledTimes(2);
    expect(
      (
        host.applyEvent.mock.calls[1]![0] as {
          assistantMessageEvents: unknown[];
        }
      ).assistantMessageEvents,
    ).toHaveLength(MAX_ASSISTANT_STREAM_BATCH_EVENTS);
    vi.runOnlyPendingTimers();
    expect(host.applyEvent).toHaveBeenCalledTimes(3);
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

  it("rebuilds instead of dropping a malformed frame from a live sequence", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    socket.onmessage?.({ data: "{broken" });

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
  });

  it.each([
    ["authority", { type: "snapshot", snapshotDigest, data: snapshot.data }],
    ["digest", { type: "snapshot", authorityId, data: snapshot.data }],
  ])("rejects a first snapshot without its %s witness", (_field, event) => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;

    socket.emit(event);

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.applyEvent).not.toHaveBeenCalled();
  });

  it("rejects a malformed authoritative snapshot after synchronization", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    socket.emit({
      type: "snapshot",
      data: { active: null, runState: "unknown", sessionStatuses: {} },
    });

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
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
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
  });
});
