import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  MAX_JOINING_EVENT_BYTES,
  MAX_RUNTIME_EVENT_BYTES,
} from "../../server/runtime-event-sockets.js";
import { ToolArgumentStream } from "../../server/tool-argument-stream.js";
import {
  applyAssistantMessageDelta,
  assistantStreamTextLength,
} from "../../shared/assistant-stream.js";
import {
  closeHostApiFixture,
  hostApiFixture,
  observeEventSocket,
  token,
} from "./fixtures/host-api.js";
import { closeWithoutPeerAck, rawWebSocket } from "./fixtures/raw-websocket.js";
import { deferredSignal } from "./fixtures/runtime.js";

describe("WebSocket observation and transport limits", () => {
  let application: Awaited<ReturnType<typeof hostApiFixture>>["application"];
  let runtime: Awaited<ReturnType<typeof hostApiFixture>>["runtime"];
  let baseUrl: Awaited<ReturnType<typeof hostApiFixture>>["baseUrl"];
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({ application, runtime, baseUrl } = fixture);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  async function connect(query = "") {
    const { socket, frames } = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?${query.replace(/^&/, "")}`,
    );
    let socketError: Error | undefined;
    socket.on("error", (error) => {
      socketError = error;
    });
    try {
      await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"), {
        timeout: 4_000,
      });
      return { socket, frames };
    } catch (error) {
      socket.terminate();
      throw socketError ?? error;
    }
  }

  it("retains detail before synchronization and releases only the departing subscription", async () => {
    const observers = new Map<string, number>();
    Object.assign(runtime, {
      retainSessionView: (id: string) => {
        observers.set(id, (observers.get(id) ?? 0) + 1);
        return () => {
          const remaining = (observers.get(id) ?? 1) - 1;
          if (remaining) observers.set(id, remaining);
          else observers.delete(id);
        };
      },
    });
    await runtime.openSession("fixture-active");
    await runtime.openSession("fixture-history");
    const originalSnapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(async (sessionId) => {
      if (sessionId) expect(observers.get(sessionId)).toBeGreaterThan(0);
      return originalSnapshot(sessionId);
    });
    const a = await connect("detail=fixture-active");
    let secondSocket: WebSocket | undefined;
    try {
      const b = await connect("detail=fixture-active");
      secondSocket = b.socket;
      expect(observers.get("fixture-active")).toBe(2);
      a.socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: "fixture-history",
          revision: 1,
        }),
      );
      await vi.waitFor(() => expect(observers.get("fixture-history")).toBe(1));
      expect(observers.get("fixture-active")).toBe(1);
      b.socket.close();
      await vi.waitFor(() =>
        expect(observers.has("fixture-active")).toBe(false),
      );
      expect(observers.get("fixture-history")).toBe(1);
      a.socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: null,
          revision: 2,
        }),
      );
      await vi.waitFor(() => expect(observers.size).toBe(0));
      a.socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: "fixture-active",
          revision: 3,
        }),
      );
      await vi.waitFor(() => expect(observers.get("fixture-active")).toBe(1));
      await application.close();
      expect(observers.size).toBe(0);
    } finally {
      a.socket.close();
      secondSocket?.close();
    }
  }, 15_000);

  it.each(["open", "already closing"] as const)(
    "drains an %s event peer without waiting for a close ACK",
    async (state) => {
      await runtime.openSession("fixture-active");
      const release = vi.fn();
      Object.assign(runtime, { retainSessionView: vi.fn(() => release) });
      const peer = await rawWebSocket(
        `${baseUrl}/events?detail=fixture-active`,
        {
          Authorization: `Bearer ${token}`,
        },
      );
      try {
        await vi.waitFor(() =>
          expect(peer.messages.some((frame) => frame.type === "snapshot")).toBe(
            true,
          ),
        );
        if (state === "already closing") {
          peer.send({ type: "detail_interest", invalid: true });
          await vi.waitFor(() => expect(peer.closeCodes).toEqual([1008]));
        }
        await closeWithoutPeerAck(() => application.close(), peer);
        expect(release).toHaveBeenCalledOnce();
        expect(application.server.listening).toBe(false);
      } finally {
        peer.destroy();
      }
    },
  );

  it("releases a retained view when the initial snapshot fails", async () => {
    const release = vi.fn();
    const retain = vi.fn(() => release);
    Object.assign(runtime, { retainSessionView: retain });
    vi.spyOn(runtime, "snapshot").mockRejectedValue(
      new Error("Session is gone"),
    );
    const { socket } = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=fixture-active`,
    );
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(retain).toHaveBeenCalledWith("fixture-active");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it("isolates socket detail while delivering global outcomes, needs-input and update acknowledgements", async () => {
    await runtime.openSession("fixture-active");
    await runtime.openSession("fixture-history");
    await fixture.localRequest.get("/api/update").expect(200);
    const observed = await fixture.localRequest
      .get("/api/pi-update")
      .expect(200);
    const identity = observed.body.updateStatus
      .availableUpdateIdentity as string;
    const a = await connect("detail=fixture-active");
    let secondSocket: WebSocket | undefined;
    try {
      const b = await connect("detail=fixture-history");
      secondSocket = b.socket;
      expect(a.frames[0]?.data?.active?.sessionId).toBe("fixture-active");
      expect(b.frames[0]?.data?.active?.sessionId).toBe("fixture-history");
      a.frames.length = 0;
      b.frames.length = 0;
      const chunks = [..."abcdefghij"];
      for (const sessionId of ["fixture-active", "fixture-history"]) {
        runtime.emit("event", {
          type: "agent_start",
          sessionId,
          sessionStatus: { runState: "running" },
        });
        for (const [index, delta] of chunks.entries())
          runtime.emit("event", {
            type: "message_update",
            sessionId,
            streamDelta: true,
            streamMessageKey: `${sessionId}-assistant`,
            streamTextLength: index + 1,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta,
            },
            message: {
              role: "assistant",
              content: [
                { type: "text", text: chunks.slice(0, index + 1).join("") },
              ],
            },
            sessionStatus: { runState: "running" },
          });
        runtime.emit("event", {
          type: "extension_ui_request",
          sessionId,
          title: "private dialog body",
          sessionStatus: {
            runState: "running",
            needsInput: true,
            external: true,
          },
        });
        runtime.emit("event", {
          type: "agent_settled",
          sessionId,
          messages: ["private settled body"],
          sessionStatus: { runState: "idle", indicator: "completed" },
        });
        runtime.emit("event", {
          type: "runtime_error",
          sessionId,
          message: "private error detail",
          sessionStatus: { runState: "failed", indicator: "failed" },
        });
      }
      const dismissed = await fixture.localRequest
        .post("/api/update/snooze")
        .send({ identity })
        .expect(200);
      await vi.waitFor(() => {
        for (const { frames } of [a, b]) {
          expect(
            frames.filter((frame) => frame.type === "runtime_error"),
          ).toHaveLength(2);
          expect(frames).toContainEqual(
            expect.objectContaining({
              type: "update_status",
              updateStatus: expect.objectContaining({
                updateSnoozedUntil: dismissed.body.updateSnoozedUntil,
              }),
            }),
          );
        }
      });
      for (const [viewer, selected, background] of [
        [a, "fixture-active", "fixture-history"],
        [b, "fixture-history", "fixture-active"],
      ] as const) {
        const batches = viewer.frames.filter(
          (frame) => frame.type === "message_update_batch",
        );
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({
          sessionId: selected,
          streamMessageKey: `${selected}-assistant`,
          streamTextLength: chunks.length,
          assistantMessageEvents: chunks.map((delta) => ({
            type: "text_delta",
            delta,
          })),
        });
        expect(batches[0]).not.toHaveProperty("message");
        const global = viewer.frames.filter(
          (frame) => frame.sessionId === background,
        );
        expect(global.map((frame) => frame.type)).toEqual([
          "agent_start",
          "session_status",
          "agent_settled",
          "runtime_error",
        ]);
        expect(global[1]?.sessionStatus?.needsInput).toBe(true);
        expect(global[1]?.sessionStatus?.external).toBe(true);
        expect(JSON.stringify(global)).not.toContain("private");
      }
    } finally {
      a.socket.close();
      secondSocket?.close();
    }
  }, 25_000);

  it("fences changed interest snapshots and queues global and new-owner changes across the read", async () => {
    await runtime.openSession("fixture-active");
    await runtime.openSession("fixture-history");
    const originalSnapshot = runtime.snapshot.bind(runtime);
    const oldRead = deferredSignal();
    const newRead = deferredSignal();
    const snapshotSpy = vi
      .spyOn(runtime, "snapshot")
      .mockImplementation(async (sessionId) => {
        const snapshot = await originalSnapshot(sessionId);
        await (sessionId === "fixture-active" ? oldRead : newRead).promise;
        return snapshot;
      });
    const { socket, frames } = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=fixture-active`,
    );
    try {
      await new Promise<void>((resolve) => socket.once("open", resolve));
      runtime.emit("event", {
        type: "agent_start",
        sessionId: "fixture-active",
        sessionStatus: { runState: "running" },
      });
      socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: "fixture-history",
          revision: 1,
        }),
      );
      await vi.waitFor(() =>
        expect(snapshotSpy).toHaveBeenCalledWith("fixture-history"),
      );
      runtime.emit("event", {
        type: "message_update",
        sessionId: "fixture-history",
        streamDelta: true,
        streamMessageKey: "new-assistant",
        streamTextLength: 9,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "new-owner",
        },
        message: { role: "assistant", content: "new-owner" },
      });
      expect(frames).toHaveLength(0);
      newRead.resolve();
      await vi.waitFor(() => expect(frames[0]?.detailRevision).toBe(1));
      oldRead.resolve();
      runtime.emit("event", {
        type: "agent_settled",
        sessionId: "fixture-active",
        messages: ["old-owner-body"],
        sessionStatus: { runState: "idle" },
      });
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.type === "agent_settled")).toBe(
          true,
        ),
      );
      expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(
        1,
      );
      expect(frames[0]?.data?.active?.sessionId).toBe("fixture-history");
      expect(frames.map((frame) => frame.type)).toEqual([
        "snapshot",
        "agent_start",
        "message_update",
        "agent_settled",
      ]);
      expect(JSON.stringify(frames)).not.toContain("old-owner-body");
      expect(snapshotSpy).toHaveBeenCalledWith("fixture-history");
    } finally {
      oldRead.resolve();
      newRead.resolve();
      socket.close();
    }
  });

  it("confirms an unchanged bootstrap before releasing the joining backlog", async () => {
    const bootstrap = await fixture.localRequest
      .get("/api/bootstrap")
      .expect(200);
    const read = deferredSignal();
    const snapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(async () => {
      await read.promise;
      return snapshot();
    });
    const { socket, frames } = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?snapshot=${bootstrap.body.snapshotDigest}`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      runtime.emit("event", {
        type: "agent_start",
        sessionId: "fixture-active",
        sessionStatus: { runState: "running" },
      });
      expect(frames).toEqual([]);
      read.resolve();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[0]).toEqual({
        type: "snapshot",
        authorityId: application.authorityId,
        snapshotDigest: bootstrap.body.snapshotDigest,
        updateStatus: bootstrap.body.updateStatus,
        detailSessionId: null,
        detailRevision: 0,
        unchanged: true,
      });
      expect(frames[1]).toMatchObject({
        type: "agent_start",
        sessionId: "fixture-active",
      });
    } finally {
      read.resolve();
      socket.close();
    }
  });

  it("streams a large write as compact bounded argument batches only to detail viewers", async () => {
    await runtime.openSession("fixture-active");
    const { socket: detail, frames } = await connect("detail=fixture-active");
    const { socket: background, frames: backgroundFrames } = await connect();
    try {
      let message: unknown = {
        role: "assistant",
        timestamp: 20,
        content: [],
        __inspireLiveId: "wire-write",
        __inspireStreamRevision: 0,
      };
      let revision = 0;
      let cumulativeBytes = 0;
      const emit = (event: unknown) =>
        runtime.emit("event", {
          sessionId: "fixture-active",
          ...(event as Record<string, unknown>),
        });
      emit({ type: "message_start", message });
      const project = (assistantMessageEvent: Record<string, unknown>) => {
        message = {
          ...applyAssistantMessageDelta(message, assistantMessageEvent),
          __inspireStreamRevision: ++revision,
        };
        const event = {
          type: "message_update",
          streamDelta: true,
          streamMessageKey: "live:wire-write",
          streamRevision: revision,
          streamTextLength: assistantStreamTextLength(message),
          assistantMessageEvent,
          message,
        };
        cumulativeBytes += Buffer.byteLength(JSON.stringify(event));
        emit(event);
      };
      project({
        type: "toolcall_start",
        contentIndex: 0,
        id: "write-1",
        toolName: "write",
      });
      const parser = new ToolArgumentStream();
      const source = JSON.stringify({
        path: "src/large.ts",
        content: Array.from(
          { length: 5000 },
          (_, n) => `export const value${n} = ${n};`,
        ).join("\n"),
      });
      for (let offset = 0; offset < source.length; offset += 128) {
        const before = parser.truncated;
        const argumentUpdates = parser.feed(source.slice(offset, offset + 128));
        if (argumentUpdates.length || parser.truncated !== before)
          project({
            type: "toolcall_delta",
            contentIndex: 0,
            argumentUpdates,
            argumentChars: parser.characters,
            argumentsTruncated: parser.truncated,
          });
        if (offset % 2048 === 0 && !parser.truncated)
          await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // A following ordinary event flushes all pending deltas in order.
      emit({
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "write",
        args: {},
      });
      const executionStart = await vi.waitFor(() => {
        const index = frames.findIndex(
          (frame) =>
            frame.type === "tool_execution_start" &&
            frame.toolCallId === "write-1",
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
      });
      const beforeExecution = frames.slice(0, executionStart);
      const batches = beforeExecution.filter(
        (frame) => frame.type === "message_update_batch",
      );
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every((frame) => frame.message === undefined)).toBe(true);
      expect(
        batches.some(
          (frame) =>
            Number(frame.sourceEventCount) >
            (frame.assistantMessageEvents as unknown[]).length,
        ),
      ).toBe(true);
      let reconstructed: unknown;
      let previousRevision = 0;
      for (const frame of beforeExecution.filter((frame) =>
        frame.type.startsWith("message_"),
      )) {
        if (frame.type === "message_start") reconstructed = frame.message;
        else {
          expect(frame.streamRevision).toBe(
            previousRevision + Number(frame.sourceEventCount),
          );
          previousRevision = Number(frame.streamRevision);
          for (const delta of frame.assistantMessageEvents as unknown[])
            reconstructed = applyAssistantMessageDelta(reconstructed, delta);
          expect(assistantStreamTextLength(reconstructed)).toBe(
            frame.streamTextLength,
          );
          reconstructed = {
            ...(reconstructed as Record<string, unknown>),
            __inspireStreamRevision: frame.streamRevision,
          };
        }
      }
      expect(reconstructed).toEqual(message);
      expect(
        backgroundFrames.filter(
          (frame) =>
            frame.type.startsWith("message_") ||
            frame.type.startsWith("tool_execution"),
        ),
      ).toEqual([]);
      const deltaBytes = batches.reduce(
        (sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)),
        0,
      );
      expect(deltaBytes).toBeLessThan(48_000);
      expect(cumulativeBytes).toBeGreaterThan(deltaBytes * 30);
    } finally {
      detail.close();
      background.close();
    }
  });

  it.each([
    "oversized event",
    "unserializable event",
    "joining backlog",
  ] as const)(
    "closes the affected socket when it cannot deliver a %s",
    async (failure) => {
      const snapshotReady = deferredSignal();
      if (failure === "joining backlog") {
        const snapshot = runtime.snapshot.bind(runtime);
        vi.spyOn(runtime, "snapshot").mockImplementation(async () => {
          await snapshotReady.promise;
          return snapshot();
        });
      }
      const { socket, frames } = observeEventSocket(
        `${baseUrl.replace("http", "ws")}/events`,
      );
      try {
        await once(socket, "open");
        if (failure !== "joining backlog")
          await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
        const closed = once(socket, "close");
        if (failure === "joining backlog") {
          const payload = "x".repeat(64 * 1024);
          for (
            let sent = 0;
            sent <= MAX_JOINING_EVENT_BYTES;
            sent += payload.length
          )
            runtime.emit("event", { type: "message_update", payload });
        } else {
          runtime.emit(
            "event",
            failure === "oversized event"
              ? {
                  type: "extension_display",
                  payload: "x".repeat(MAX_RUNTIME_EVENT_BYTES + 1),
                }
              : { type: "runtime_event", data: 1n },
          );
        }
        expect((await closed)[0]).toBe(1013);
      } finally {
        snapshotReady.resolve();
        socket.close();
      }
    },
  );
});

it("keeps joined sockets observable and terminates clients that stop answering pings", async () => {
  const fixture = await hostApiFixture({ websocketHeartbeatIntervalMs: 20 });
  const url = `${fixture.baseUrl.replace("http", "ws")}/events`;
  const { socket, frames } = observeEventSocket(url);
  let unresponsive: WebSocket | undefined;
  try {
    await once(socket, "ping");
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "heartbeat")).toBe(true),
    );
    unresponsive = observeEventSocket(url, { autoPong: false }).socket;
    expect((await once(unresponsive, "close"))[0]).toBe(1006);
  } finally {
    socket.close();
    unresponsive?.close();
    await closeHostApiFixture(fixture);
  }
});
