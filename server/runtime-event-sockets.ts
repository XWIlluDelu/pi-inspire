import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../shared/assistant-stream.js";
import {
  isSessionRuntimeStatus,
  MAX_SESSION_ID_CHARS,
} from "../shared/contracts.js";
import { maintainBrowserSockets, terminateUpgradedSockets } from "./browser-socket-lifecycle.js";
import type { RuntimeController } from "./runtime.js";
import type {
  NotificationPrincipal,
  TaskNotifications,
} from "./task-notifications.js";
import { compactToolArgumentEvents } from "./tool-argument-batches.js";
import type { UpdateCoordinator } from "./update-coordinator.js";

export const MAX_JOINING_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const STREAM_EVENT_BATCH_INTERVAL_MS = 16;
const sessionIdField = z.string().min(1).max(MAX_SESSION_ID_CHARS);

interface RuntimeEventSocketOptions {
  runtime: Pick<
    RuntimeController,
    "on" | "off" | "snapshot" | "retainSessionView" | "warmSessionView"
  >;
  updateCoordinator: Pick<UpdateCoordinator, "status" | "subscribe">;
  authorityId: string;
  heartbeatIntervalMs: number;
  taskNotifications?: Pick<TaskNotifications, "attach">;
}

/** Owns /events projection and socket lifetimes, not HTTP authentication or
 * Host selection. The caller admits upgrades only after its shared auth check. */
export function createRuntimeEventSockets({
  runtime,
  updateCoordinator,
  authorityId,
  heartbeatIntervalMs,
  taskNotifications,
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
  type DetailInterest = { sessionId: string | null; revision: number };
  interface EventFrame {
    message: string;
    bytes: number;
    sequence?: number;
    sessionId?: string;
    background?: string;
  }
  type SnapshotBacklog = { frames: EventFrame[]; bytes: number };
  type Peer = {
    responsive: boolean;
    interest: DetailInterest;
    releaseView?: () => void;
    backlog?: SnapshotBacklog;
    principal?: NotificationPrincipal;
    unsubscribe?: () => void;
    backgroundStatuses: Map<string, string>;
  };
  const peers = new Map<WebSocket, Peer>();
  const setDetailInterest = (peer: Peer, interest: DetailInterest) => {
    // Retain the new view before releasing the previous subscription.
    const release = peer.releaseView;
    peer.releaseView = interest.sessionId
      ? runtime.retainSessionView(interest.sessionId)
      : undefined;
    peer.interest = interest;
    peer.backgroundStatuses.clear();
    release?.();
  };
  const wantsDetail = (peer: Peer, sessionId: string) =>
    peer.interest.sessionId === sessionId;
  type Audience = "all" | "joining" | "established";
  interface PendingStreamBatch {
    key: string;
    events: unknown[];
    latest: Record<string, unknown>;
    approximateBytes: number;
  }
  let pendingStreamBatch: PendingStreamBatch | null = null;
  let streamBatchTimer: ReturnType<typeof setTimeout> | null = null;
  const forgetSocket = (socket: WebSocket): void => {
    const peer = peers.get(socket);
    if (!peer) return;
    peers.delete(socket);
    peer.backlog = undefined;
    peer.unsubscribe?.();
    peer.releaseView?.();
  };
  const closeLaggingSocket = (socket: WebSocket, reason: string) => {
    const peer = peers.get(socket);
    if (peer) peer.backlog = undefined;
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.close(1013, reason);
    } catch {
      forgetSocket(socket);
      socket.terminate();
    }
  };
  const sendBounded = (
    socket: WebSocket,
    message: string,
    bytes = Buffer.byteLength(message),
  ): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + bytes > MAX_SOCKET_BUFFERED_BYTES) {
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
  const stopHeartbeat = maintainBrowserSockets(
    peers, heartbeatIntervalMs,
    (peer) => !peer.backlog, sendBounded, forgetSocket,
  );

  const queueOrSend = (socket: WebSocket, peer: Peer, frame: EventFrame) => {
    const queue = peer.backlog;
    if (!queue) sendBounded(socket, frame.message, frame.bytes);
    else if (queue.bytes + frame.bytes > MAX_JOINING_EVENT_BYTES)
      closeLaggingSocket(socket, "Snapshot backlog exceeded");
    else {
      queue.frames.push(frame);
      queue.bytes += frame.bytes;
    }
  };

  const encode = (
    event: unknown,
    sequence?: number,
    sessionId?: string,
    background?: string,
  ): EventFrame | undefined => {
    try {
      const message = JSON.stringify(event);
      if (message !== undefined)
        return {
          message,
          bytes: Buffer.byteLength(message),
          sequence,
          sessionId,
          background,
        };
    } catch {
      // Projection errors close affected sockets without interrupting the runtime.
    }
  };

  const isAudience = (peer: Peer, audience: Audience, sessionId?: string) =>
    (!sessionId || wantsDetail(peer, sessionId)) &&
    (audience === "all" || Boolean(peer.backlog) === (audience === "joining"));

  const publish = (
    frame: EventFrame | undefined,
    audience: Audience,
    sessionId?: string,
    reason = frame
      ? "Runtime event exceeded projection budget"
      : "Runtime event was not serializable",
  ): void => {
    for (const [socket, peer] of peers) {
      if (!isAudience(peer, audience, sessionId)) continue;
      if (frame && frame.bytes <= MAX_RUNTIME_EVENT_BYTES)
        queueOrSend(socket, peer, frame);
      else closeLaggingSocket(socket, reason);
    }
  };
  const flushStreamBatch = (): void => {
    if (streamBatchTimer) clearTimeout(streamBatchTimer);
    streamBatchTimer = null;
    const pending = pendingStreamBatch;
    pendingStreamBatch = null;
    if (!pending) return;
    const batch = {
      ...pending.latest,
      type: "message_update_batch",
      assistantMessageEvent: undefined,
      assistantMessageEvents: compactToolArgumentEvents(pending.events),
      sourceEventCount: pending.events.length,
    };
    publish(encode(batch), "established", String(pending.latest.sessionId));
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
    "external_attachment_ended",
  ]);
  const compactStatus = (
    record: Record<string, unknown>,
    sessionId: string,
  ) => {
    const sourceStatus = record.sessionStatus;
    const status = isSessionRuntimeStatus(sourceStatus)
      ? {
          runState: sourceStatus.runState,
          ...(sourceStatus.indicator
            ? { indicator: sourceStatus.indicator }
            : {}),
          ...(sourceStatus.attentionId !== undefined
            ? { attentionId: sourceStatus.attentionId }
            : {}),
          ...(sourceStatus.needsInput !== undefined
            ? { needsInput: sourceStatus.needsInput }
            : {}),
          ...(sourceStatus.external !== undefined
            ? { external: sourceStatus.external }
            : {}),
          ...(sourceStatus.queueAdmission ? { queueAdmission: true } : {}),
        }
      : undefined;
    const lifecycle = globalLifecycle.has(String(record.type));
    if (!status && !lifecycle) return;
    return {
      lifecycle,
      status,
      event: {
        type: lifecycle ? record.type : "session_status",
        sessionId,
        runtimeSequence: record.runtimeSequence,
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
      },
    };
  };
  const publishBackgroundStatus = (
    record: Record<string, unknown>,
    sessionId: string,
    sequence?: number,
  ): string | undefined => {
    const compact = compactStatus(record, sessionId);
    if (!compact) return;
    const frame = encode(compact.event, sequence);
    if (!frame) return;
    const { lifecycle, status } = compact;
    const statusKey = status && JSON.stringify(status);
    for (const [socket, peer] of peers) {
      if (wantsDetail(peer, sessionId)) continue;
      const statuses = peer.backgroundStatuses;
      if (!lifecycle && statuses.get(sessionId) === statusKey) continue;
      if (statusKey !== undefined) statuses.set(sessionId, statusKey);
      queueOrSend(socket, peer, frame);
    }
    return frame.message;
  };

  const publishRuntimeEvent = (event: unknown): void => {
    const record =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : undefined;
    const sessionId =
      typeof record?.sessionId === "string" ? record.sessionId : undefined;
    const sequence =
      typeof record?.runtimeSequence === "number"
        ? record.runtimeSequence
        : undefined;
    const background =
      sessionId && record
        ? publishBackgroundStatus(record, sessionId, sequence)
        : undefined;
    // Avoid serializing a session body nobody subscribed to.
    if (![...peers.values()].some((peer) => isAudience(peer, "all", sessionId)))
      return;
    if (
      (record?.type === "session_projection_changed" ||
        record?.type === "branch_changed") &&
      !record.transcript
    ) {
      publish(
        undefined,
        "all",
        sessionId,
        "Session view could not be projected",
      );
      return;
    }
    if (
      !record ||
      record.type !== "message_update" ||
      record.streamDelta !== true ||
      !sessionId ||
      typeof record.streamMessageKey !== "string" ||
      record.assistantMessageEvent === undefined
    ) {
      const frame = encode(event, sequence, sessionId, background);
      if (frame && frame.bytes <= MAX_RUNTIME_EVENT_BYTES) flushStreamBatch();
      publish(frame, "all", sessionId);
      return;
    }

    const { message: _, streamDelta: __, ...compact } = record;
    const delta = encode(
      {
        ...compact,
        type: "message_update_batch",
        assistantMessageEvent: undefined,
        assistantMessageEvents: [record.assistantMessageEvent],
        sourceEventCount: 1,
      },
      sequence,
      sessionId,
      background,
    );
    if (!delta || delta.bytes > MAX_RUNTIME_EVENT_BYTES) {
      publish(delta, "all", sessionId);
      return;
    }
    // An addressed join can capture the middle of a coalesced batch.
    // Buffer fragments individually so the snapshot sequence can cut within it.
    publish(delta, "joining", sessionId);
    if (
      ![...peers].some(
        ([socket, peer]) =>
          socket.readyState === WebSocket.OPEN &&
          isAudience(peer, "established", sessionId),
      )
    )
      return;
    const key = `${record.sessionId}\0${record.streamMessageKey}`;
    if (
      pendingStreamBatch &&
      (pendingStreamBatch.key !== key ||
        pendingStreamBatch.events.length >= MAX_ASSISTANT_STREAM_BATCH_EVENTS ||
        pendingStreamBatch.approximateBytes + delta.bytes >
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
    pendingStreamBatch.approximateBytes += delta.bytes;
    scheduleStreamBatch();
  };
  const unsubscribeUpdateStatus = updateCoordinator.subscribe((status) =>
    publishRuntimeEvent({ type: "update_status", updateStatus: status }),
  );
  runtime.on("event", publishRuntimeEvent);

  function startPeer(socket: WebSocket, peer: Peer): void {
    // Flush to the old audience before admitting a new snapshot reader.
    flushStreamBatch();
    peers.set(socket, peer);
    socket.on("pong", () => {
      peer.responsive = true;
    });
    socket.on("error", () => {
      forgetSocket(socket);
      socket.terminate();
    });
    socket.on("close", () => forgetSocket(socket));
    const readInterest = async ({ sessionId }: DetailInterest) => {
      try {
        return {
          snapshot: await runtime.snapshot(sessionId),
          missingDetail: false,
        };
      } catch (error) {
        if (
          sessionId === null ||
          (error as { code?: string })?.code !== "SESSION_NOT_FOUND"
        )
          throw error;
        return { snapshot: await runtime.snapshot(null), missingDetail: true };
      }
    };
    const synchronize = (next?: DetailInterest): void => {
      // Flush under the old audience before buffering the new view.
      flushStreamBatch();
      if (next) setDetailInterest(peer, next);
      const previous = peer.backlog;
      const queue = {
        frames: previous?.frames ?? [],
        bytes: previous?.bytes ?? 0,
      };
      peer.backlog = queue;
      const { interest } = peer;
      void Promise.all([
        readInterest(interest),
        updateCoordinator.status(),
      ]).then(
        ([{ snapshot, missingDetail }, updateStatus]) => {
          const queued = peer.backlog;
          if (queued !== queue) return;
          // Pending batches exclude this joining socket, which already queued
          // their individual deltas. Flush before it becomes established.
          flushStreamBatch();
          peer.backlog = undefined;
          if (socket.readyState !== WebSocket.OPEN) return;
          if (missingDetail)
            setDetailInterest(peer, { ...interest, sessionId: null });
          const cut = snapshot.runtimeSequence;
          let message: string;
          try {
            message = JSON.stringify({
              type: "snapshot",
              authorityId,
              runtimeSequence: cut,
              updateStatus,
              detailSessionId: interest.sessionId,
              detailRevision: interest.revision,
              ...(missingDetail ? { missingDetail: true } : {}),
              data: snapshot,
            });
          } catch {
            socket.close(1011, "Session state was not serializable");
            return;
          }
          if (!sendBounded(socket, message)) return;
          if (peer.principal && taskNotifications && !peer.unsubscribe)
            peer.unsubscribe = taskNotifications.attach(
              peer.principal,
              (event) => sendBounded(socket, JSON.stringify(event)),
            );
          for (const frame of queued.frames) {
            if (
              cut !== undefined &&
              frame.sequence !== undefined &&
              frame.sequence <= cut
            )
              continue;
            // A superseded detail read may have queued former-view frames.
            const message =
              frame.sessionId && !wantsDetail(peer, frame.sessionId)
                ? frame.background
                : frame.message;
            if (message && !sendBounded(socket, message)) return;
          }
          if (peer.interest.sessionId)
            runtime.warmSessionView(peer.interest.sessionId);
        },
        () => {
          if (peer.backlog !== queue) return;
          peer.backlog = undefined;
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
        if (interest.revision <= peer.interest.revision)
          throw new Error("Stale interest");
        synchronize(interest);
      } catch {
        socket.close(1008, "Invalid detail interest");
      }
    });
    synchronize();
  }

  return {
    upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      url: URL,
      notificationPrincipal?: NotificationPrincipal,
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
        const interest = { sessionId: detail || null, revision: 0 };
        const peer: Peer = {
          responsive: true,
          interest,
          backgroundStatuses: new Map(),
          principal: notificationPrincipal,
        };
        setDetailInterest(peer, interest);
        startPeer(client, peer);
      });
    },
    close(): void {
      stopHeartbeat();
      if (streamBatchTimer) clearTimeout(streamBatchTimer);
      streamBatchTimer = null;
      pendingStreamBatch = null;
      runtime.off("event", publishRuntimeEvent);
      unsubscribeUpdateStatus();
      for (const socket of peers.keys()) {
        forgetSocket(socket);
        socket.close(1001, "Server shutting down");
      }
    },
    terminateRemaining: () => terminateUpgradedSockets(websocket),
  };
}
