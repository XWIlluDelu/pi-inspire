// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketTicket } from "../../src/browser-auth";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../../shared/assistant-stream";
import {
  ConnectionController,
  FIRST_SNAPSHOT_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
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
  it("backs off ticket failures and fences stale or stopped admissions", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const admission = vi.mocked(socketTicket);
    const original = admission.getMockImplementation();
    admission.mockRejectedValueOnce(new Error("503"));
    await controller.connect(null);
    expect(host.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(host.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.reconnect).toHaveBeenCalledOnce();
    let complete!: (ticket: string) => void;
    admission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stale = controller.connect(null);
    await controller.connect(null);
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    complete("stale");
    await stale;
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    admission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stopped = controller.connect(null);
    controller.stop();
    complete("stopped");
    await stopped;
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    if (original) admission.mockImplementation(original);
  });

  it("keeps socket-local interest through selection, stale snapshots, and resume", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const state = { ...host.state(), sessionId: "a" as string | null };
    host.state.mockImplementation(() => state);
    await controller.connect(null);
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
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      new URL(ImmediateCloseSocket.instances[1].url).searchParams.get("detail"),
    ).toBe("");
    expect(host.reconnect).not.toHaveBeenCalled();
  });

  it("sends a selection committed while the handshake was still connecting", async () => {
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const state = { ...host.state() };
    host.state.mockImplementation(() => state);
    await controller.connect(null);
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

  it("detaches a replaced socket before an eager close callback can reconnect", async () => {
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("first");
    const first = ImmediateCloseSocket.instances[0]!;
    await controller.connect("second");

    expect(host.onTransportReplaced).toHaveBeenCalledOnce();
    expect(host.onTransportClosed).not.toHaveBeenCalled();
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(first.url).toContain("ticket=fixture-socket-ticket");
    expect(first.url).not.toContain("token=");
  });

  it("tries one lightweight resume before falling back to bootstrap", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("retry-token");
    ImmediateCloseSocket.instances[0]!.onclose?.();

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);

    ImmediateCloseSocket.instances[1]!.onclose?.();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(host.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.reconnect).toHaveBeenCalledWith("retry-token");
  });

  it("opens from an unchanged runtime snapshot after applying its out-of-band witness", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("token");
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

  it("keeps Host-wide update events outside the runtime snapshot digest", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("token");
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

  it("publishes open only after applying the authoritative first snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("token");
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

  it.each([false, true])(
    "bounds a blackhole (socket opened: %s)",
    async (opened) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", ImmediateCloseSocket);
      const { controller, host } = harness();
      await controller.connect("token");
      const socket = ImmediateCloseSocket.instances[0]!;
      if (opened) socket.open();
      const deadline = opened
        ? FIRST_SNAPSHOT_TIMEOUT_MS
        : SOCKET_CONNECT_TIMEOUT_MS;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(socket.closeCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.closeCount).toBe(1);
      expect(host.onTransportClosed).toHaveBeenCalledOnce();
      // Late callbacks cannot publish state or schedule an additional retry.
      socket.open();
      socket.emit(snapshot);
      socket.onclose?.();
      expect(host.applyEvent).not.toHaveBeenCalled();
      expect(host.onTransportClosed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ImmediateCloseSocket.instances).toHaveLength(2);
    },
  );

  it("gives a slow valid snapshot its own budget after a slow connection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    await vi.advanceTimersByTimeAsync(SOCKET_CONNECT_TIMEOUT_MS - 1);
    socket.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.closeCount).toBe(0);
    expect(host.patch).not.toHaveBeenCalledWith({
      connection: "open",
      connectionProblem: null,
    });
    socket.emit(snapshot);
    expect(host.patch).toHaveBeenLastCalledWith({
      connection: "open",
      connectionProblem: null,
    });
    expect(host.applyEvent).toHaveBeenCalledBefore(host.recordSnapshotDigest);
    await vi.advanceTimersByTimeAsync(FIRST_SNAPSHOT_TIMEOUT_MS - 30_000);
    expect(socket.closeCount).toBe(0);
  });

  it("allows slow selection snapshots but bounds a missing one despite healthy heartbeats", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    const state = { ...host.state() };
    host.state.mockImplementation(() => state);
    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    state.sessionId = "b";
    controller.updateDetailInterest();
    await vi.advanceTimersByTimeAsync(30_000);
    socket.emit({ ...snapshot, detailSessionId: "b", detailRevision: 1 });
    expect(socket.closeCount).toBe(0);
    state.sessionId = "c";
    controller.updateDetailInterest();
    await vi.advanceTimersByTimeAsync(30_000);
    socket.emit({ type: "heartbeat" });
    await vi.advanceTimersByTimeAsync(FIRST_SNAPSHOT_TIMEOUT_MS - 30_000);
    expect(socket.closeCount).toBe(1);
  });

  it("retires a socket error without depending on a later close event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.close = vi.fn();
    socket.onerror?.();
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    socket.emit(snapshot);
    expect(host.applyEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(host.reconnect).not.toHaveBeenCalled();
  });

  it("resets its inactivity watchdog on valid heartbeat frames", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    await vi.advanceTimersByTimeAsync(20_000);
    socket.emit({ type: "heartbeat" });
    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS - 1);
    expect(host.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(ImmediateCloseSocket.instances[1]?.url).toContain(
      `snapshot=${snapshotDigest}`,
    );
  });

  it("keeps a recent stream on visibility return but rebuilds it on online", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();

    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    controller.recover("visible");
    expect(host.reconnect).not.toHaveBeenCalled();

    controller.recover("online");
    await Promise.resolve();
    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
  });

  it("coalesces complete partial messages but flushes before lifecycle events", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
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

  it("merges ordered delta batches and flushes them before lifecycle events", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
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

  it("publishes a bounded delta batch before retaining its continuation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
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

  it("releases the latest partial message on its render timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
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
    await vi.advanceTimersByTimeAsync(15);
    expect(host.applyEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.applyEvent).toHaveBeenCalledTimes(2);
    expect(host.applyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "message_update",
        message: expect.objectContaining({ content: "ab" }),
      }),
    );
  });

  it("rebuilds instead of dropping a malformed frame from a live sequence", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    socket.onmessage?.({ data: "{broken" });

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
  });

  it.each([
    ["authority", { type: "snapshot", snapshotDigest, data: snapshot.data }],
    ["digest", { type: "snapshot", authorityId, data: snapshot.data }],
  ])(
    "rejects a first snapshot without its %s witness",
    async (_field, event) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", ImmediateCloseSocket);
      const { controller, host } = harness();
      await controller.connect("token");
      const socket = ImmediateCloseSocket.instances[0]!;

      socket.emit(event);

      expect(socket.closeCount).toBe(1);
      expect(host.onTransportClosed).toHaveBeenCalledOnce();
      expect(host.applyEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed authoritative snapshot after synchronization", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    await controller.connect("token");
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

  it("rebuilds from a snapshot when a live reducer rejects an event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const { controller, host } = harness();
    host.applyEvent.mockImplementation((event: { type?: string }) => {
      if (event.type === "agent_start") throw new Error("invalid transition");
    });
    await controller.connect("token");
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    socket.emit({ type: "agent_start", sessionId: "session-a" });

    expect(socket.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
  });
});
