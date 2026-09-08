import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../shared/assistant-stream.js";
import {
  isSessionRuntimeStatus,
  MAX_SESSION_ID_CHARS,
} from "../shared/contracts.js";
import type { RuntimeLike } from "./runtime.js";
import type { UpdateCoordinatorLike } from "./update-coordinator.js";
import { compactToolArgumentEvents } from "./tool-argument-batches.js";

export const MAX_JOINING_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const STREAM_EVENT_BATCH_INTERVAL_MS = 16;
const sessionIdField = z.string().min(1).max(MAX_SESSION_ID_CHARS);

interface RuntimeEventSocketOptions {
  runtime: Pick<RuntimeLike, "on" | "off" | "snapshot">;
  updateCoordinator: Pick<UpdateCoordinatorLike, "status" | "subscribe">;
  authorityId: string;
  heartbeatIntervalMs: number;
}

/** Owns /events projection and socket lifetimes, not HTTP authentication or
 * Host selection. The caller admits upgrades only after its shared auth check. */
export function createRuntimeEventSockets({
  runtime,
  updateCoordinator,
  authorityId,
  heartbeatIntervalMs,
}: RuntimeEventSocketOptions) {
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1_024,
    },
  });
  const sockets = new Set<WebSocket>();
  /** Sockets still waiting for their snapshot; live events queue here so the
   * first frame a client processes is always the authoritative snapshot,
   * with the queued events flushed after it in arrival order. */
  const joining = new Map<WebSocket, { messages: string[]; bytes: number }>();
  const responsiveSockets = new Map<WebSocket, boolean>();
  const requestedSnapshotDigests = new WeakMap<WebSocket, string | null>();
  const detailInterests = new WeakMap<
    WebSocket,
    { sessionId: string | null; revision: number }
  >();
  const backgroundStatuses = new WeakMap<WebSocket, Map<string, string>>();
  const wantsDetail = (socket: WebSocket, sessionId: string): boolean =>
    detailInterests.get(socket)?.sessionId === sessionId;
  interface EventDestinations {
    joining: boolean;
    established: boolean;
    sessionId?: string;
  }
  interface PendingStreamBatch {
    key: string;
    events: unknown[];
    latest: Record<string, unknown>;
    approximateBytes: number;
  }
  let pendingStreamBatch: PendingStreamBatch | null = null;
  let streamBatchTimer: ReturnType<typeof setTimeout> | null = null;
  const forgetSocket = (socket: WebSocket): void => {
    sockets.delete(socket);
    joining.delete(socket);
    responsiveSockets.delete(socket);
  };
  const closeLaggingSocket = (socket: WebSocket, reason: string) => {
    joining.delete(socket);
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.close(1013, reason);
    } catch {
      forgetSocket(socket);
      socket.terminate();
    }
  };
  const sendBounded = (socket: WebSocket, message: string): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (
      socket.bufferedAmount + Buffer.byteLength(message) >
      MAX_SOCKET_BUFFERED_BYTES
    ) {
      closeLaggingSocket(socket, "Client fell behind");
      return false;
    }
    try {
      socket.send(message);
      return true;
    } catch {
      forgetSocket(socket);
      socket.terminate();
      return false;
    }
  };
  const heartbeatMessage = JSON.stringify({ type: "heartbeat" });
  const heartbeatInterval = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!responsiveSockets.get(socket)) {
        joining.delete(socket);
        socket.terminate();
        continue;
      }
      responsiveSockets.set(socket, false);
      try {
        socket.ping();
      } catch {
        joining.delete(socket);
        socket.terminate();
        continue;
      }
      // Never overtake the authoritative first snapshot. Once joined, this
      // application frame also gives browser clients an observable watchdog.
      if (!joining.has(socket)) sendBounded(socket, heartbeatMessage);
    }
  }, heartbeatIntervalMs);
  heartbeatInterval.unref();

  const broadcastEncoded = (
    message: string,
    messageBytes: number,
    destinations: EventDestinations,
  ): void => {
    for (const socket of sockets) {
      if (
        destinations.sessionId &&
        !wantsDetail(socket, destinations.sessionId)
      )
        continue;
      const queue = joining.get(socket);
      if (queue) {
        if (!destinations.joining) continue;
        if (queue.bytes + messageBytes > MAX_JOINING_EVENT_BYTES) {
          closeLaggingSocket(socket, "Snapshot backlog exceeded");
        } else {
          queue.messages.push(message);
          queue.bytes += messageBytes;
        }
      } else if (destinations.established) {
        sendBounded(socket, message);
      }
    }
  };
  const serializeRuntimeEvent = (
    event: unknown,
  ): { message: string; bytes: number } | null => {
    try {
      const message = JSON.stringify(event);
      if (message === undefined) return null;
      return { message, bytes: Buffer.byteLength(message) };
    } catch {
      return null;
    }
  };
  const closeProjectionDestinations = (
    reason: string,
    destinations: EventDestinations,
  ): void => {
    for (const socket of sockets) {
      if (
        destinations.sessionId &&
        !wantsDetail(socket, destinations.sessionId)
      )
        continue;
      const isJoining = joining.has(socket);
      if (
        (isJoining && destinations.joining) ||
        (!isJoining && destinations.established)
      )
        closeLaggingSocket(socket, reason);
    }
  };
  const flushStreamBatch = (): void => {
    if (streamBatchTimer) clearTimeout(streamBatchTimer);
    streamBatchTimer = null;
    const pending = pendingStreamBatch;
    pendingStreamBatch = null;
    if (!pending) return;
    const batch: Record<string, unknown> = { ...pending.latest };
    delete batch.message;
    delete batch.assistantMessageEvent;
    delete batch.streamDelta;
    batch.type = "message_update_batch";
    batch.assistantMessageEvents = compactToolArgumentEvents(pending.events);
    batch.sourceEventCount = pending.events.length;
    const destinations = {
      joining: false,
      established: true,
      sessionId: String(batch.sessionId),
    };
    const encoded = serializeRuntimeEvent(batch);
    if (!encoded) {
      closeProjectionDestinations(
        "Runtime event was not serializable",
        destinations,
      );
      return;
    }
    if (encoded.bytes > MAX_RUNTIME_EVENT_BYTES) {
      closeProjectionDestinations(
        "Runtime event exceeded projection budget",
        destinations,
      );
      return;
    }
    broadcastEncoded(encoded.message, encoded.bytes, destinations);
  };
  const scheduleStreamBatch = (): void => {
    if (streamBatchTimer) return;
    streamBatchTimer = setTimeout(
      flushStreamBatch,
      STREAM_EVENT_BATCH_INTERVAL_MS,
    );
    streamBatchTimer.unref();
  };
  // Preserve global operation ownership and outcomes, never their bodies.
  const globalLifecycle = new Set([
    "agent_start",
    "auto_retry_start",
    "compaction_start",
    "compaction_end",
    "agent_settled",
    "runtime_error",
    "runtime_ready",
  ]);
  const compactStatus = (
    record: Record<string, unknown>,
    sessionId: string,
  ): string | null => {
    const sourceStatus = record.sessionStatus;
    const status = isSessionRuntimeStatus(sourceStatus)
      ? {
          runState: sourceStatus.runState,
          ...(sourceStatus.indicator
            ? { indicator: sourceStatus.indicator }
            : {}),
          ...(sourceStatus.needsInput !== undefined
            ? { needsInput: sourceStatus.needsInput }
            : {}),
        }
      : undefined;
    const lifecycle = globalLifecycle.has(String(record.type));
    if (!status && !lifecycle) return null;
    return JSON.stringify({
      type: lifecycle ? record.type : "session_status",
      sessionId,
      ...(status ? { sessionStatus: status } : {}),
      ...(record.type === "compaction_start"
        ? { reason: record.reason === "manual" ? "manual" : "auto" }
        : {}),
      ...(record.type === "compaction_end"
        ? {
            result: record.result == null ? null : {},
            aborted: record.aborted === true,
            ...(typeof record.errorMessage === "string" &&
            record.errorMessage.trim()
              ? { errorMessage: "Compaction failed" }
              : {}),
          }
        : {}),
    });
  };
  const publishBackgroundStatus = (
    record: Record<string, unknown>,
    sessionId: string,
  ): void => {
    const compact = compactStatus(record, sessionId);
    if (!compact) return;
    const lifecycle = globalLifecycle.has(String(record.type));
    const statusKey = isSessionRuntimeStatus(record.sessionStatus)
      ? JSON.stringify(record.sessionStatus)
      : undefined;
    for (const socket of sockets) {
      if (wantsDetail(socket, sessionId)) continue;
      const statuses =
        backgroundStatuses.get(socket) ?? new Map<string, string>();
      backgroundStatuses.set(socket, statuses);
      if (
        !lifecycle &&
        (statusKey === undefined || statuses.get(sessionId) === statusKey)
      )
        continue;
      if (statusKey !== undefined) statuses.set(sessionId, statusKey);
      const queue = joining.get(socket);
      if (queue) {
        const bytes = Buffer.byteLength(compact);
        if (queue.bytes + bytes > MAX_JOINING_EVENT_BYTES)
          closeLaggingSocket(socket, "Snapshot backlog exceeded");
        else {
          queue.messages.push(compact);
          queue.bytes += bytes;
        }
      } else sendBounded(socket, compact);
    }
  };
  const publishRuntimeEvent = (event: unknown): void => {
    const record =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : null;
    const sessionId =
      typeof record?.sessionId === "string" ? record.sessionId : undefined;
    const destinations = { joining: true, established: true, sessionId };
    if (sessionId && record) {
      publishBackgroundStatus(record, sessionId);
      // Do not even serialize a session body nobody subscribed to.
      if (![...sockets].some((socket) => wantsDetail(socket, sessionId)))
        return;
    }
    const streamDelta =
      record?.type === "message_update" &&
      record.streamDelta === true &&
      typeof record.sessionId === "string" &&
      typeof record.streamMessageKey === "string" &&
      record.assistantMessageEvent !== undefined;
    if (!streamDelta || !record) {
      const encoded = serializeRuntimeEvent(event);
      if (!encoded) {
        // A transport projection failure must not throw back through the
        // runtime operation that emitted it. Re-bootstrap every client.
        closeProjectionDestinations(
          "Runtime event was not serializable",
          destinations,
        );
        return;
      }
      if (encoded.bytes > MAX_RUNTIME_EVENT_BYTES) {
        // The next bootstrap snapshot is the recovery authority. Never enqueue
        // one exceptional object into every browser socket.
        closeProjectionDestinations(
          "Runtime event exceeded projection budget",
          destinations,
        );
        return;
      }
      flushStreamBatch();
      broadcastEncoded(encoded.message, encoded.bytes, destinations);
      return;
    }

    if (sockets.size === 0) return;

    // Joining sockets need complete, overlap-safe replacements. Avoid the
    // cumulative-message stringify entirely when every socket is established;
    // otherwise that hidden O(response length × fragments) cost survives even
    // after wire deltas have removed the redundant network bytes.
    if (
      [...joining.keys()].some((socket) =>
        wantsDetail(socket, String(sessionId)),
      )
    ) {
      const complete = serializeRuntimeEvent(event);
      if (!complete) {
        closeProjectionDestinations("Runtime event was not serializable", {
          joining: true,
          established: false,
          sessionId,
        });
      } else if (complete.bytes > MAX_RUNTIME_EVENT_BYTES) {
        closeProjectionDestinations(
          "Runtime event exceeded projection budget",
          {
            joining: true,
            established: false,
            sessionId,
          },
        );
      } else {
        broadcastEncoded(complete.message, complete.bytes, {
          joining: true,
          established: false,
          sessionId,
        });
      }
    }
    const hasEstablishedSocket = [...sockets].some(
      (socket) =>
        !joining.has(socket) &&
        socket.readyState === WebSocket.OPEN &&
        wantsDetail(socket, String(sessionId)),
    );
    if (!hasEstablishedSocket) return;

    const compact = { ...record };
    delete compact.message;
    delete compact.streamDelta;
    const compactEncoded = serializeRuntimeEvent(compact);
    if (!compactEncoded) {
      closeProjectionDestinations("Runtime event was not serializable", {
        joining: false,
        established: true,
        sessionId,
      });
      return;
    }
    const key = `${record.sessionId}\0${record.streamMessageKey}`;
    if (
      pendingStreamBatch &&
      (pendingStreamBatch.key !== key ||
        pendingStreamBatch.events.length >= MAX_ASSISTANT_STREAM_BATCH_EVENTS ||
        pendingStreamBatch.approximateBytes + compactEncoded.bytes >
          MAX_RUNTIME_EVENT_BYTES)
    )
      flushStreamBatch();
    if (!pendingStreamBatch) {
      pendingStreamBatch = {
        key,
        events: [],
        latest: compact,
        approximateBytes: 0,
      };
    }
    pendingStreamBatch.events.push(record.assistantMessageEvent);
    pendingStreamBatch.latest = compact;
    pendingStreamBatch.approximateBytes += compactEncoded.bytes;
    scheduleStreamBatch();
  };
  const unsubscribeUpdateStatus = updateCoordinator.subscribe((status) =>
    publishRuntimeEvent({ type: "update_status", updateStatus: status }),
  );
  runtime.on("event", publishRuntimeEvent);

  websocket.on("connection", (socket) => {
    // A stream batch belongs only to the sockets that were established when
    // its first delta arrived. Flush before admitting a new snapshot reader.
    flushStreamBatch();
    sockets.add(socket);
    responsiveSockets.set(socket, true);
    socket.on("pong", () => responsiveSockets.set(socket, true));
    socket.on("error", () => {
      forgetSocket(socket);
      socket.terminate();
    });
    socket.on("close", () => forgetSocket(socket));
    const synchronize = (): void => {
      flushStreamBatch();
      const previous = joining.get(socket);
      const queue = {
        messages: previous?.messages ?? [],
        bytes: previous?.bytes ?? 0,
      };
      joining.set(socket, queue);
      const interest = detailInterests.get(socket);
      void Promise.all([
        runtime.snapshot(interest?.sessionId),
        updateCoordinator.status(),
      ]).then(
        ([snapshot, updateStatus]) => {
          const queued = joining.get(socket);
          if (queued !== queue) return;
          // Pending batches exclude this joining socket, which already queued
          // their complete projections. Flush before it becomes established.
          flushStreamBatch();
          joining.delete(socket);
          if (!queued || socket.readyState !== WebSocket.OPEN) return;
          let message: string;
          try {
            const encodedSnapshot = JSON.stringify(snapshot);
            const snapshotDigest = createHash("sha256")
              .update(encodedSnapshot)
              .digest("hex");
            const unchanged =
              requestedSnapshotDigests.get(socket) === snapshotDigest;
            message = JSON.stringify({
              type: "snapshot",
              authorityId,
              snapshotDigest,
              updateStatus,
              ...(interest
                ? {
                    detailSessionId: interest.sessionId,
                    detailRevision: interest.revision,
                  }
                : {}),
              ...(unchanged ? { unchanged: true } : { data: snapshot }),
            });
          } catch {
            socket.close(1011, "Session state was not serializable");
            return;
          }
          if (!sendBounded(socket, message)) return;
          for (const message of queued.messages) {
            // A superseded read may have queued detail for the previous owner.
            // Retain its global lifecycle evidence, never replay its body.
            const record = JSON.parse(message) as Record<string, unknown>;
            const id =
              typeof record.sessionId === "string" ? record.sessionId : null;
            const projected =
              id && !wantsDetail(socket, id)
                ? compactStatus(record, id)
                : message;
            if (projected && !sendBounded(socket, projected)) break;
          }
        },
        () => {
          if (joining.get(socket) !== queue) return;
          joining.delete(socket);
          socket.close(1011, "Unable to load session state");
        },
      );
    };
    socket.on("message", (data, binary) => {
      try {
        if (
          binary ||
          Buffer.byteLength(data.toString()) > MAX_SESSION_ID_CHARS * 6 + 256
        )
          throw new Error("Invalid interest");
        const interest = z
          .object({
            type: z.literal("detail_interest"),
            sessionId: sessionIdField.nullable(),
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .parse(JSON.parse(data.toString()));
        if (interest.revision <= (detailInterests.get(socket)?.revision ?? 0))
          throw new Error("Stale interest");
        // Flush under the OLD audience, then begin the NEW snapshot queue
        // synchronously, before any asynchronous runtime read can yield.
        flushStreamBatch();
        detailInterests.set(socket, interest);
        backgroundStatuses.delete(socket);
        requestedSnapshotDigests.set(socket, null);
        synchronize();
      } catch {
        socket.close(1008, "Invalid detail interest");
      }
    });
    synchronize();
  });

  return {
    upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      url: URL,
    ): void {
      const detail = url.searchParams.get("detail");
      if (
        detail !== null &&
        detail !== "" &&
        !sessionIdField.safeParse(detail).success
      ) {
        socket.destroy();
        return;
      }
      websocket.handleUpgrade(request, socket, head, (client) => {
        detailInterests.set(client, { sessionId: detail || null, revision: 0 });
        const requestedDigest = url.searchParams.get("snapshot");
        requestedSnapshotDigests.set(
          client,
          requestedDigest && /^[0-9a-f]{64}$/u.test(requestedDigest)
            ? requestedDigest
            : null,
        );
        websocket.emit("connection", client, request);
      });
    },
    close(): void {
      clearInterval(heartbeatInterval);
      if (streamBatchTimer) clearTimeout(streamBatchTimer);
      streamBatchTimer = null;
      pendingStreamBatch = null;
      runtime.off("event", publishRuntimeEvent);
      unsubscribeUpdateStatus();
      for (const socket of sockets) socket.close(1001, "Server shutting down");
    },
  };
}
