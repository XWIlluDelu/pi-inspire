import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
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
  type DetailFrame,
  hostApiFixture,
  observeEventSocket,
  token,
} from "./fixtures/host-api.js";
import { closeWithoutPeerAck, rawWebSocket } from "./fixtures/raw-websocket.js";

function eventSocket(url: string, options: import("ws").ClientOptions = {}) {
  return new WebSocket(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}` },
  });
}

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
    const observed = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?${query.replace(/^&/, "")}`,
    );
    await vi.waitFor(() => expect(observed.frames[0]?.type).toBe("snapshot"));
    return observed;
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
    await runtime.openSession("mock-active");
    await runtime.openSession("mock-older");
    const originalSnapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(async (sessionId) => {
      if (sessionId) expect(observers.get(sessionId)).toBeGreaterThan(0);
      return originalSnapshot(sessionId);
    });
    const a = await connect("detail=mock-active");
    const b = await connect("detail=mock-active");
    try {
      expect(observers.get("mock-active")).toBe(2);
      a.socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: "mock-older",
          revision: 1,
        }),
      );
      await vi.waitFor(() => expect(observers.get("mock-older")).toBe(1));
      expect(observers.get("mock-active")).toBe(1);
      b.socket.close();
      await vi.waitFor(() => expect(observers.has("mock-active")).toBe(false));
      expect(observers.get("mock-older")).toBe(1);
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
          sessionId: "mock-active",
          revision: 3,
        }),
      );
      await vi.waitFor(() => expect(observers.get("mock-active")).toBe(1));
      await application.close();
      expect(observers.size).toBe(0);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it.each(["open", "already closing"] as const)(
    "drains an %s event peer without waiting for a close ACK",
    async (state) => {
      await runtime.openSession("mock-active");
      const release = vi.fn();
      Object.assign(runtime, { retainSessionView: vi.fn(() => release) });
      const peer = await rawWebSocket(`${baseUrl}/events?detail=mock-active`, {
        Authorization: `Bearer ${token}`,
      });
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
    const socket = eventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(retain).toHaveBeenCalledWith("mock-active");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it("broadcasts one update acknowledgement to every connected view", async () => {
    await request(application.server)
      .get("/api/update")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const observed = await request(application.server)
      .get("/api/pi-update")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const identity = observed.body.updateStatus
      .availableUpdateIdentity as string;
    expect(identity).toBeTruthy();

    const [localView, remoteView] = await Promise.all([connect(), connect()]);
    try {
      const dismissed = await request(application.server)
        .post("/api/update/snooze")
        .set("Authorization", `Bearer ${token}`)
        .send({ identity })
        .expect(200);
      await vi.waitFor(() => {
        for (const view of [localView, remoteView])
          expect(
            view.frames.some((frame) => frame.type === "update_status"),
          ).toBe(true);
      });
      const localFrame = localView.frames.find(
        (frame) => frame.type === "update_status",
      )!;
      const remoteFrame = remoteView.frames.find(
        (frame) => frame.type === "update_status",
      )!;
      expect(localFrame.updateStatus).toMatchObject({
        updateSnoozedUntil: dismissed.body.updateSnoozedUntil,
      });
      expect(remoteFrame.updateStatus).toEqual(localFrame.updateStatus);
    } finally {
      localView.socket.close();
      remoteView.socket.close();
    }
  });

  it("isolates two socket detail interests while retaining global outcomes and needs-input", async () => {
    await runtime.openSession("mock-active");
    await runtime.openSession("mock-older");
    const connect = async (id: string, digest?: string) => {
      const frames: DetailFrame[] = [];
      const socket = eventSocket(
        `${baseUrl.replace("http", "ws")}/events?detail=${id}${digest ? `&snapshot=${digest}` : ""}`,
      );
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
      await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
      return { socket, frames };
    };
    const a = await connect("mock-active");
    const b = await connect("mock-older");
    try {
      expect(a.frames[0]?.data?.active?.sessionId).toBe("mock-active");
      expect(b.frames[0]?.data?.active?.sessionId).toBe("mock-older");
      const resumed = await connect("mock-active", a.frames[0]?.snapshotDigest);
      expect(resumed.frames[0]).toMatchObject({
        unchanged: true,
        detailSessionId: "mock-active",
        detailRevision: 0,
      });
      resumed.socket.close();
      const changed = await connect("mock-active", "0".repeat(64));
      expect(changed.frames[0]?.unchanged).toBeUndefined();
      expect(changed.frames[0]?.data?.active?.sessionId).toBe("mock-active");
      changed.socket.close();
      a.frames.length = 0;
      b.frames.length = 0;
      // No connection owns this body: even an unserializable detail must not
      // disconnect unrelated viewers or enter the encoded-event path.
      runtime.emit("event", {
        type: "message_update",
        sessionId: "unobserved",
        message: 1n,
        sessionStatus: { runState: "running" },
      });
      for (const sessionId of ["mock-active", "mock-older"]) {
        runtime.emit("event", {
          type: "agent_start",
          sessionId,
          sessionStatus: { runState: "running" },
        });
        for (let index = 0; index < 10; index++)
          runtime.emit("event", {
            type: "message_update",
            sessionId,
            streamDelta: true,
            streamMessageKey: `${sessionId}-assistant`,
            streamTextLength: index + 1,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "x",
            },
            message: {
              role: "assistant",
              content: [{ type: "text", text: "x".repeat(index + 1) }],
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
      await vi.waitFor(() =>
        expect(
          a.frames.filter((frame) => frame.type === "runtime_error"),
        ).toHaveLength(2),
      );
      await vi.waitFor(() =>
        expect(
          b.frames.filter((frame) => frame.type === "runtime_error"),
        ).toHaveLength(2),
      );
      for (const [viewer, selected, background] of [
        [a, "mock-active", "mock-older"],
        [b, "mock-older", "mock-active"],
      ] as const) {
        expect(
          viewer.frames
            .filter((frame) => frame.type === "message_update_batch")
            .map((frame) => frame.sessionId),
        ).toEqual([selected]);
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
        expect(JSON.stringify(global)).not.toContain("assistantMessageEvents");
      }
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it("fences changed interest snapshots and queues global and new-owner changes across the read", async () => {
    await runtime.openSession("mock-active");
    await runtime.openSession("mock-older");
    const originalSnapshot = runtime.snapshot.bind(runtime);
    let release!: () => void;
    let releaseNew!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const snapshotSpy = vi
      .spyOn(runtime, "snapshot")
      .mockImplementation(async (sessionId) => {
        const snapshot = await originalSnapshot(sessionId);
        await (sessionId === "mock-active" ? gate : newGate);
        return snapshot;
      });
    const frames: DetailFrame[] = [];
    const socket = eventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve) => socket.once("open", resolve));
      runtime.emit("event", {
        type: "agent_start",
        sessionId: "mock-active",
        sessionStatus: { runState: "running" },
      });
      socket.send(
        JSON.stringify({
          type: "detail_interest",
          sessionId: "mock-older",
          revision: 1,
        }),
      );
      await vi.waitFor(() =>
        expect(snapshotSpy).toHaveBeenCalledWith("mock-older"),
      );
      runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-older",
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
      releaseNew();
      await vi.waitFor(() => expect(frames[0]?.detailRevision).toBe(1));
      release();
      runtime.emit("event", {
        type: "agent_settled",
        sessionId: "mock-active",
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
      expect(frames[0]?.data?.active?.sessionId).toBe("mock-older");
      expect(frames.map((frame) => frame.type)).toEqual([
        "snapshot",
        "agent_start",
        "message_update",
        "agent_settled",
      ]);
      expect(JSON.stringify(frames)).not.toContain("old-owner-body");
      expect(snapshotSpy).toHaveBeenCalledWith("mock-older");
    } finally {
      release();
      releaseNew();
      socket.close();
    }
  });

  it("delivers the snapshot before any live event on a new socket", async () => {
    let releaseSnapshot!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseSnapshot = resolveGate;
    });
    const snapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(async () => {
      await gate;
      return snapshot();
    });
    const { socket, frames } = observeEventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      // A live event lands while the snapshot is still loading; it must not
      // overtake the snapshot frame.
      runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-active",
      });
      releaseSnapshot();

      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[0]?.type).toBe("snapshot");
      expect(frames[1]?.type).toBe("message_update");
    } finally {
      releaseSnapshot();
      socket.close();
    }
  });

  it("confirms an unchanged bootstrap snapshot without retransmitting it", async () => {
    const bootstrap = await request(application.server)
      .get("/api/bootstrap")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const socket = eventSocket(
      `${baseUrl.replace("http", "ws")}/events?snapshot=${bootstrap.body.snapshotDigest}`,
    );
    try {
      const firstFrame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          socket.once("message", (data) =>
            resolve(JSON.parse(data.toString()) as Record<string, unknown>),
          );
          socket.once("error", reject);
        },
      );
      expect(firstFrame).toEqual({
        type: "snapshot",
        authorityId: application.authorityId,
        snapshotDigest: bootstrap.body.snapshotDigest,
        updateStatus: bootstrap.body.updateStatus,
        detailSessionId: null,
        detailRevision: 0,
        unchanged: true,
      });
    } finally {
      socket.close();
    }
  });

  it("streams a large write as compact bounded argument batches only to detail viewers", async () => {
    await runtime.openSession("mock-active");
    const detail = eventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    const background = eventSocket(`${baseUrl.replace("http", "ws")}/events`);
    const frames: Array<Record<string, unknown> & { type: string }> = [];
    const backgroundFrames: Array<Record<string, unknown> & { type: string }> =
      [];
    detail.on("message", (data) => frames.push(JSON.parse(data.toString())));
    background.on("message", (data) =>
      backgroundFrames.push(JSON.parse(data.toString())),
    );
    try {
      await vi.waitFor(() => {
        expect(frames[0]?.type).toBe("snapshot");
        expect(backgroundFrames[0]?.type).toBe("snapshot");
      });
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
          sessionId: "mock-active",
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
      await vi.waitFor(() =>
        expect(frames.at(-1)?.type).toBe("tool_execution_start"),
      );
      const batches = frames.filter(
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
      for (const frame of frames.filter((frame) =>
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
      console.info(
        "Large-write WebSocket JSON bytes (before optional compression):",
        {
          sourceBytes: Buffer.byteLength(source),
          previewCharacters: parser.characters,
          batches: batches.length,
          deltaBytes,
          cumulativeBytes,
        },
      );
    } finally {
      detail.close();
      background.close();
    }
  });

  it("batches ordered assistant deltas without retransmitting cumulative messages", async () => {
    await runtime.openSession("mock-active");
    const socket = eventSocket(
      `${baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("message", () => resolve());
        socket.once("error", reject);
      });
      const batchFrame = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("stream batch did not arrive")),
            2_000,
          );
          socket.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as Record<
              string,
              unknown
            >;
            if (frame.type !== "message_update_batch") return;
            clearTimeout(timeout);
            resolve(frame);
          });
        },
      );
      runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-active",
        streamDelta: true,
        streamMessageKey: "live:assistant-1",
        streamTextLength: 1,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "a",
        },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
        },
      });
      runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-active",
        streamDelta: true,
        streamMessageKey: "live:assistant-1",
        streamTextLength: 2,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "b",
        },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ab" }],
        },
      });
      const frame = await batchFrame;
      expect(frame).toMatchObject({
        type: "message_update_batch",
        sessionId: "mock-active",
        streamMessageKey: "live:assistant-1",
        streamTextLength: 2,
        assistantMessageEvents: [
          { type: "text_delta", delta: "a" },
          { type: "text_delta", delta: "b" },
        ],
      });
      expect(frame).not.toHaveProperty("message");
    } finally {
      socket.close();
    }
  });

  it("keeps joined sockets observable and terminates clients that stop answering pings", async () => {
    const heartbeat = await hostApiFixture({
      websocketHeartbeatIntervalMs: 20,
    });
    const url = `${heartbeat.baseUrl.replace("http", "ws")}/events`;
    const responsive = eventSocket(url);
    try {
      const ping = new Promise<void>((resolve) =>
        responsive.once("ping", resolve),
      );
      const heartbeat = new Promise<void>((resolve, reject) => {
        responsive.on("message", (data) => {
          try {
            const frame = JSON.parse(data.toString()) as { type?: unknown };
            if (frame.type === "heartbeat") resolve();
          } catch (error) {
            reject(error);
          }
        });
        responsive.once("error", reject);
      });
      await Promise.race([
        Promise.all([ping, heartbeat]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("heartbeat was not observed")),
            1_000,
          ),
        ),
      ]);
      responsive.close();

      const unresponsive = eventSocket(url, { autoPong: false });
      const closed = new Promise<number>((resolve, reject) => {
        unresponsive.once("close", resolve);
        unresponsive.once("error", () => undefined);
        setTimeout(
          () => reject(new Error("unresponsive socket remained open")),
          1_000,
        );
      });
      expect(await closed).toBe(1006);
    } finally {
      responsive.close();
      await closeHostApiFixture(heartbeat);
    }
  });

  it.each([
    [
      "oversized",
      {
        type: "extension_display",
        payload: "x".repeat(MAX_RUNTIME_EVENT_BYTES + 1),
      },
    ],
    ["unserializable", { type: "runtime_event", data: 1n }],
  ])(
    "retires joined sockets without failing the emitter for a %s event",
    async (_failure, event) => {
      const { socket } = await connect();
      try {
        const closed = new Promise<number>((resolve) =>
          socket.once("close", resolve),
        );
        expect(() => runtime.emit("event", event)).not.toThrow();
        expect(await closed).toBe(1013);
      } finally {
        socket.close();
      }
    },
  );

  it("closes a joining socket whose pre-snapshot event backlog exceeds the bound", async () => {
    let releaseSnapshot!: () => void;
    const gate = new Promise<void>(
      (resolveGate) => (releaseSnapshot = resolveGate),
    );
    const snapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(async () => {
      await gate;
      return snapshot();
    });
    const socket = eventSocket(`${baseUrl.replace("http", "ws")}/events`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const closed = new Promise<number>((resolve) =>
        socket.once("close", resolve),
      );
      const payload = "x".repeat(64 * 1024);
      for (
        let sent = 0;
        sent <= MAX_JOINING_EVENT_BYTES;
        sent += payload.length
      ) {
        runtime.emit("event", { type: "message_update", payload });
      }
      expect(await closed).toBe(1013);
    } finally {
      releaseSnapshot();
      socket.close();
    }
  });
});
