import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { BROWSER_UPGRADE_CLOSE } from "../shared/browser-build.mjs";
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../shared/assistant-stream.js";
import {
  isSessionRuntimeStatus,
  MAX_SESSION_ID_CHARS,
} from "../shared/contracts.js";
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
    "on" | "off" | "snapshot" | "eventSnapshotCut" | "retainSessionView"
  >;
  updateCoordinator: Pick<UpdateCoordinator, "status" | "subscribe">;
  authorityId: string;
  heartbeatIntervalMs: number;
  currentBrowserBuild?(): Promise<string | undefined>;
  taskNotifications?: Pick<TaskNotifications, "attach">;
}

/** Owns /events projection and socket lifetimes, not HTTP authentication or
 * Host selection. The caller admits upgrades only after its shared auth check. */
export function createRuntimeEventSockets({
  runtime,
  updateCoordinator,
  authorityId,
  heartbeatIntervalMs,
  currentBrowserBuild,
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
  type SnapshotBacklog = { messages: string[]; bytes: number };
  type Peer = {
    responsive: boolean;
    interest: DetailInterest;
    releaseView?: () => void;
    backlog?: SnapshotBacklog;
    principal?: NotificationPrincipal;
    unsubscribe?: () => void;
    backgroundStatuses: Map<string, string>;
    browserBuild?: string;
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
  let checkingBuild = false;
  const heartbeatInterval = setInterval(() => {
    if (!checkingBuild && currentBrowserBuild) {
      checkingBuild = true;
      void currentBrowserBuild()
        .then((current) => {
          for (const [socket, peer] of peers) {
            if (current && peer.browserBuild && current !== peer.browserBuild) {
              forgetSocket(socket);
              socket.close(BROWSER_UPGRADE_CLOSE, "Reload Inspire");
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          checkingBuild = false;
        });
    }
    for (const [socket, peer] of peers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!peer.responsive) {
        peer.backlog = undefined;
        socket.terminate();
        continue;
      }
      peer.responsive = false;
      try {
        socket.ping();
      } catch {
        peer.backlog = undefined;
        socket.terminate();
        continue;
      }
      // Never overtake the authoritative first snapshot. Once joined, this
      // application frame also gives browser clients an observable watchdog.
      if (!peer.backlog) sendBounded(socket, heartbeatMessage);
    }
  }, heartbeatIntervalMs);
  heartbeatInterval.unref();

  const queueOrSend = (
    socket: WebSocket,
    peer: Peer,
    message: string,
    bytes: number,
  ) => {
    const queue = peer.backlog;
    if (!queue) {
      sendBounded(socket, message);
    } else if (queue.bytes + bytes > MAX_JOINING_EVENT_BYTES) {
      closeLaggingSocket(socket, "Snapshot backlog exceeded");
    } else {
      queue.messages.push(message);
      queue.bytes += bytes;
    }
  };

  const broadcastEncoded = (
    message: string,
    messageBytes: number,
    destinations: EventDestinations,
  ): void => {
    for (const [socket, peer] of peers) {
      if (destinations.sessionId && !wantsDetail(peer, destinations.sessionId))
        continue;
      if (peer.backlog ? destinations.joining : destinations.established)
        queueOrSend(socket, peer, message, messageBytes);
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
    for (const [socket, peer] of peers) {
      if (destinations.sessionId && !wantsDetail(peer, destinations.sessionId))
        continue;
      const isJoining = peer.backlog !== undefined;
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
    "external_attachment_ended",
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
    if (!status && !lifecycle) return null;
    return JSON.stringify({
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
    const bytes = Buffer.byteLength(compact);
    for (const [socket, peer] of peers) {
      if (wantsDetail(peer, sessionId)) continue;
      const statuses = peer.backgroundStatuses;
      if (
        !lifecycle &&
        (statusKey === undefined || statuses.get(sessionId) === statusKey)
      )
        continue;
      if (statusKey !== undefined) statuses.set(sessionId, statusKey);
      queueOrSend(socket, peer, compact, bytes);
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
      if (![...peers.values()].some((peer) => wantsDetail(peer, sessionId)))
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

    if (peers.size === 0) return;

    const compact = { ...record };
    delete compact.message;
    delete compact.streamDelta;
    const compactEncoded = serializeRuntimeEvent(compact);
    if (!compactEncoded || compactEncoded.bytes > MAX_RUNTIME_EVENT_BYTES) {
      closeProjectionDestinations(
        compactEncoded
          ? "Runtime event exceeded projection budget"
          : "Runtime event was not serializable",
        destinations,
      );
      return;
    }
    // Keep each fragment separately in a joining backlog so a cut in the
    // middle of a transport batch cannot duplicate an already captured delta.
    if (
      [...peers.values()].some(
        (peer) => peer.backlog && wantsDetail(peer, String(sessionId)),
      )
    ) {
      const joining = serializeRuntimeEvent({
        ...compact,
        type: "message_update_batch",
        assistantMessageEvent: undefined,
        assistantMessageEvents: [compact.assistantMessageEvent],
        sourceEventCount: 1,
      })!;
      broadcastEncoded(joining.message, joining.bytes, {
        joining: true,
        established: false,
        sessionId,
      });
    }
    if (
      ![...peers].some(
        ([socket, peer]) =>
          !peer.backlog &&
          socket.readyState === WebSocket.OPEN &&
          wantsDetail(peer, String(sessionId)),
      )
    )
      return;
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
    const synchronize = (): void => {
      flushStreamBatch();
      const previous = peer.backlog;
      const queue = {
        messages: previous?.messages ?? [],
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
          const cut = runtime.eventSnapshotCut(snapshot);
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
          for (const message of queued.messages) {
            // A superseded read may have queued detail for the previous owner.
            // Retain its global lifecycle evidence, never replay its body.
            const record = JSON.parse(message) as Record<string, unknown>;
            if (
              cut !== undefined &&
              typeof record.runtimeSequence === "number" &&
              record.runtimeSequence <= cut
            )
              continue;
            const id =
              typeof record.sessionId === "string" ? record.sessionId : null;
            const projected =
              id && !wantsDetail(peer, id)
                ? compactStatus(record, id)
                : message;
            if (projected && !sendBounded(socket, projected)) break;
          }
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
        // Flush under the OLD audience, then begin the NEW snapshot queue
        // synchronously, before any asynchronous runtime read can yield.
        flushStreamBatch();
        setDetailInterest(peer, interest);
        synchronize();
      } catch {
        socket.close(1008, "Invalid detail interest");
      }
    });
    synchronize();
  }

  return {
    rejectUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      websocket.handleUpgrade(request, socket, head, (client) =>
        client.close(BROWSER_UPGRADE_CLOSE, "Reload Inspire"),
      );
    },
    upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      url: URL,
      notificationPrincipal?: NotificationPrincipal,
      browserBuild?: string,
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
          browserBuild,
        };
        setDetailInterest(peer, interest);
        startPeer(client, peer);
      });
    },
    close(): void {
      clearInterval(heartbeatInterval);
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
    async terminateRemaining(): Promise<void> {
      // Closing sockets can already be absent from the projection's set.
      await Promise.all(
        [...websocket.clients].map(
          (socket) =>
            new Promise<void>((resolveClosed) => {
              socket.once("close", () => resolveClosed());
              socket.terminate();
            }),
        ),
      );
    },
  };
}
