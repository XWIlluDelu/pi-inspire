// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../../shared/assistant-stream";
import { socketTicket } from "../../src/browser-auth";
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

beforeEach(() => {
  vi.stubGlobal("WebSocket", ImmediateCloseSocket);
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  ImmediateCloseSocket.instances = [];
});

describe("ConnectionController", () => {
  it("backs off ticket failures and fences replaced or stopped admissions", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    const admission = vi.mocked(socketTicket);
    const original = admission.getMockImplementation();
    admission.mockRejectedValueOnce(new Error("503"));
    await controller.connect();
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
    const stale = controller.connect();
    await controller.connect();
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    complete("stale");
    await stale;
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    const first = ImmediateCloseSocket.instances[0]!;
    expect(new URL(first.url).searchParams.get("ticket")).toBe(
      "fixture-socket-ticket",
    );
    expect(new URL(first.url).searchParams.has("token")).toBe(false);
    await controller.connect();
    expect(first.closeCount).toBe(1);
    expect(host.onTransportReplaced).toHaveBeenCalledOnce();
    expect(host.onTransportClosed).not.toHaveBeenCalled();
    expect(host.reconnect).toHaveBeenCalledOnce();

    admission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stopped = controller.connect();
    controller.stop();
    complete("stopped");
    await stopped;
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    if (original) admission.mockImplementation(original);
  });

  it("keeps current interest and digest through selection changes and resume", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    const state = { ...host.state(), sessionId: "a" as string | null };
    host.state.mockImplementation(() => state);
    await controller.connect();
    const socket = ImmediateCloseSocket.instances[0];
    expect(new URL(socket.url).searchParams.get("detail")).toBe("a");
    state.sessionId = "b";
    controller.updateDetailInterest();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "detail_interest",
      sessionId: "b",
      revision: 1,
      authorityId,
      snapshotDigest,
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
      authorityId,
      snapshotDigest,
    });
    socket.emit({ ...snapshot, detailSessionId: null, detailRevision: 2 });
    expect(socket.closeCount).toBe(0);

    host.invalidateSnapshotDigest.mockClear();
    host.applyEvent.mockClear();

    for (const event of [
      { type: "update_status", updateStatus: { revision: 1 } },
      {
        type: "external_session_activity",
        activities: { external: "working" },
      },
      { type: "external_session_activity", activities: {} },
      { type: "external_session_activity", activities: {} },
    ]) {
      socket.emit(event);
      expect(host.applyEvent).toHaveBeenLastCalledWith(event);
    }
    expect(host.invalidateSnapshotDigest).not.toHaveBeenCalled();

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const resumed = ImmediateCloseSocket.instances[1]!;
    const query = new URL(resumed.url).searchParams;
    expect(query.get("detail")).toBe("");
    expect(query.get("snapshot")).toBe(snapshotDigest);
    expect(host.reconnect).not.toHaveBeenCalled();
    resumed.open();
    const unchanged = {
      type: "snapshot",
      authorityId,
      snapshotDigest,
      unchanged: true,
    };
    host.recordSnapshotDigest.mockClear();
    host.patch.mockClear();
    resumed.emit(unchanged);
    expect(host.applyEvent).toHaveBeenLastCalledWith(unchanged);
    expect(host.recordSnapshotDigest).toHaveBeenCalledExactlyOnceWith(
      snapshotDigest,
    );
    expect(host.patch).toHaveBeenLastCalledWith({
      connection: "open",
      connectionProblem: null,
    });
    resumed.emit({ type: "agent_start", sessionId: "a" });
    expect(host.invalidateSnapshotDigest).toHaveBeenCalledOnce();
  });

  it("retires a socket error, tries one resume and falls back to bootstrap", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    await controller.connect();
    const first = ImmediateCloseSocket.instances[0]!;
    first.close = vi.fn();
    first.onerror?.();
    first.emit(snapshot);
    expect(host.applyEvent).not.toHaveBeenCalled();
    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(ImmediateCloseSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(host.reconnect).not.toHaveBeenCalled();

    ImmediateCloseSocket.instances[1]!.onclose?.();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(host.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.reconnect).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "bounds a blackhole (socket opened: %s)",
    async (opened) => {
      vi.useFakeTimers();
      const { controller, host } = harness();
      await controller.connect();
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

  it("gives each slow snapshot its own budget and bounds a missing selection despite heartbeats", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    const state = { ...host.state() };
    host.state.mockImplementation(() => state);
    await controller.connect();
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
    expect(socket.closeCount).toBe(0);

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

  it("keeps a healthy stream on visibility return but recovers on silence or online", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { controller, host } = harness();

    await controller.connect();
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    await vi.advanceTimersByTimeAsync(20_000);
    controller.recover("visible");
    expect(socket.closeCount).toBe(0);
    socket.emit({ type: "heartbeat" });
    expect(host.applyEvent).toHaveBeenCalledExactlyOnceWith(snapshot);
    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS - 1);
    expect(socket.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(host.onTransportClosed).toHaveBeenCalledOnce();
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(ImmediateCloseSocket.instances[1]?.url).toContain(
      `snapshot=${snapshotDigest}`,
    );
    const resumed = ImmediateCloseSocket.instances[1]!;
    resumed.open();
    resumed.emit(snapshot);

    controller.recover("online");
    await Promise.resolve();
    expect(resumed.closeCount).toBe(1);
    expect(host.onTransportClosed).toHaveBeenCalledTimes(2);
    expect(host.reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(3);
  });

  it("coalesces full-message updates and flushes on a lifecycle event or render deadline", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    await controller.connect();
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);

    const message = (content: string) => ({
      __inspireLiveId: "assistant-a",
      role: "assistant",
      content,
    });
    const update = (content: string) => ({
      type: "message_update",
      sessionId: "session-a",
      message: message(content),
    });
    socket.emit(update("a"));
    socket.emit(update("ab"));
    expect(host.applyEvent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(16);
    expect(host.applyEvent).toHaveBeenLastCalledWith(update("ab"));

    socket.emit(update("abc"));
    socket.emit(update("abcd"));
    const ended = { ...update("abcd"), type: "message_end" };
    socket.emit(ended);
    expect(host.applyEvent.mock.calls.map(([event]) => event)).toEqual([
      snapshot,
      update("ab"),
      update("abcd"),
      ended,
    ]);
  });

  it("merges ordered deltas within the batch limit and flushes before lifecycle events", async () => {
    vi.useFakeTimers();
    const { controller, host } = harness();
    await controller.connect();
    const socket = ImmediateCloseSocket.instances[0]!;
    socket.open();
    socket.emit(snapshot);
    host.applyEvent.mockClear();

    const deltaBatch = (assistant: string, text: string, offset = 0) => ({
      type: "message_update_batch",
      sessionId: "session-a",
      streamMessageKey: `live:${assistant}`,
      streamTextLength: offset + text.length,
      sourceEventCount: text.length,
      streamRevision: offset + text.length,
      assistantMessageEvents: Array.from(text, (delta) => ({
        type: "text_delta",
        delta,
      })),
    });
    socket.emit(deltaBatch("assistant-a", "a"));
    socket.emit(deltaBatch("assistant-a", "b", 1));
    expect(host.applyEvent).not.toHaveBeenCalled();

    const end = { type: "agent_end", sessionId: "session-a" };
    socket.emit(end);
    expect(host.applyEvent.mock.calls.map(([event]) => event)).toEqual([
      deltaBatch("assistant-a", "ab"),
      end,
    ]);
    host.applyEvent.mockClear();

    const limit = MAX_ASSISTANT_STREAM_BATCH_EVENTS;
    const full = deltaBatch("assistant-b", "a".repeat(limit));
    const continuation = deltaBatch("assistant-b", "b", limit);
    socket.emit(full);
    socket.emit(continuation);
    expect(host.applyEvent).toHaveBeenCalledExactlyOnceWith(full);
    vi.runOnlyPendingTimers();
    expect(host.applyEvent.mock.calls.map(([event]) => event)).toEqual([
      full,
      continuation,
    ]);
  });

  it.each([
    ["authority", { type: "snapshot", snapshotDigest, data: snapshot.data }],
    ["digest", { type: "snapshot", authorityId, data: snapshot.data }],
  ])(
    "rejects a first snapshot without its %s witness",
    async (_field, event) => {
      vi.useFakeTimers();
      const { controller, host } = harness();
      await controller.connect();
      const socket = ImmediateCloseSocket.instances[0]!;

      socket.emit(event);

      expect(socket.closeCount).toBe(1);
      expect(host.onTransportClosed).toHaveBeenCalledOnce();
      expect(host.applyEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["malformed JSON", "{broken", "resume"],
    [
      "invalid snapshot",
      JSON.stringify({
        ...snapshot,
        data: { ...snapshot.data, runState: "unknown" },
      }),
      "bootstrap",
    ],
    [
      "invalid transition",
      JSON.stringify({ type: "agent_start", sessionId: "a" }),
      "resume",
    ],
  ])(
    "recovers the authoritative sequence after %s",
    async (failure, data, recovery) => {
      vi.useFakeTimers();
      const { controller, host } = harness();
      host.applyEvent.mockImplementation((event: { type?: string }) => {
        if (event.type === "agent_start") throw new Error("invalid transition");
      });
      await controller.connect();
      const socket = ImmediateCloseSocket.instances[0]!;
      socket.open();
      socket.emit(snapshot);
      socket.onmessage?.({ data });

      if (failure !== "invalid transition")
        expect(host.applyEvent).toHaveBeenCalledExactlyOnceWith(snapshot);
      expect(socket.closeCount).toBe(1);
      expect(host.onTransportClosed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.reconnect).toHaveBeenCalledTimes(
        recovery === "bootstrap" ? 1 : 0,
      );
      expect(ImmediateCloseSocket.instances).toHaveLength(
        recovery === "bootstrap" ? 1 : 2,
      );
    },
  );
});
