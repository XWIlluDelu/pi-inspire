import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../../shared/assistant-stream";
import { isRunState, isSessionRuntimeStatus } from "../../shared/contracts";
import { structuralMessageIdentity } from "../../shared/message-identity";
import { eventsUrl } from "../api";
import type { WireEvent } from "../events";
import { recordTransportMeasure, transportNow } from "../transport-performance";

export const FIRST_SNAPSHOT_TIMEOUT_MS = 10_000;
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;
const SHORT_STREAM_RENDER_INTERVAL_MS = 16;
const MEDIUM_STREAM_RENDER_INTERVAL_MS = 32;
const LONG_STREAM_RENDER_INTERVAL_MS = 50;
const RECENT_STREAM_ACTIVITY_MS = 30_000;

function streamMessageUpdate(
  event: WireEvent,
): { event: WireEvent; key: string; textLength: number } | null {
  if (
    event.type === "message_update_batch" &&
    typeof event.sessionId === "string" &&
    typeof event.streamMessageKey === "string" &&
    typeof event.streamTextLength === "number" &&
    Number.isSafeInteger(event.streamTextLength) &&
    event.streamTextLength >= 0 &&
    Array.isArray(event.assistantMessageEvents)
  ) {
    return {
      event,
      key: `${event.sessionId}\0${event.streamMessageKey}`,
      textLength: event.streamTextLength,
    };
  }
  if (
    event.type !== "message_update" ||
    !event.message ||
    typeof event.message !== "object" ||
    Array.isArray(event.message)
  )
    return null;
  const message = event.message as Record<string, unknown>;
  const identity = structuralMessageIdentity(message);
  if (!identity) return null;
  const content = message.content;
  const textLength =
    typeof content === "string"
      ? content.length
      : Array.isArray(content)
        ? content.reduce((total, part) => {
            if (typeof part === "string") return total + part.length;
            if (!part || typeof part !== "object" || Array.isArray(part))
              return total;
            const record = part as Record<string, unknown>;
            const text =
              typeof record.text === "string"
                ? record.text
                : typeof record.thinking === "string"
                  ? record.thinking
                  : "";
            return total + text.length;
          }, 0)
        : 0;
  return {
    event,
    key: `${typeof event.sessionId === "string" ? event.sessionId : ""}\0${identity}`,
    textLength,
  };
}

function streamRenderInterval(textLength: number): number {
  if (textLength > 32_000) return LONG_STREAM_RENDER_INTERVAL_MS;
  if (textLength > 8_000) return MEDIUM_STREAM_RENDER_INTERVAL_MS;
  return SHORT_STREAM_RENDER_INTERVAL_MS;
}

export type ManagedConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "offline";
export type ManagedConnectionProblem =
  | { kind: "device-offline" }
  | { kind: "address-unreachable" }
  | { kind: "relay-unavailable" }
  | { kind: "service-error"; message: string }
  | { kind: "stream-interrupted" }
  | null;
export type ConnectionRecoveryTrigger = "online" | "pageshow" | "visible";

interface ConnectionControllerHost {
  state(): {
    bootstrapped: boolean;
    authorityId: string | null;
    snapshotDigest: string | null;
  };
  patch(patch: {
    connection?: ManagedConnectionState;
    connectionProblem?: ManagedConnectionProblem;
  }): void;
  applyEvent(event: WireEvent): void;
  recordSnapshotDigest(digest: string): void;
  invalidateSnapshotDigest(): void;
  /** A deliberate replacement invalidates ownership tied to the old stream. */
  onTransportReplaced(): void;
  /** An unexpected close invalidates stream-owned state before retrying. */
  onTransportClosed(): void;
  reconnect(token: string | null): void;
}

function parseWireEvent(data: unknown): WireEvent | null {
  try {
    const event = JSON.parse(String(data)) as unknown;
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof (event as { type?: unknown }).type !== "string"
    )
      return null;
    return event as WireEvent;
  } catch {
    return null;
  }
}

function authoritativeSnapshot(
  event: WireEvent,
  expectedAuthority: string | null,
  expectedDigest: string | null,
): { kind: "full" | "unchanged"; digest: string } | null {
  if (
    event.type !== "snapshot" ||
    !expectedAuthority ||
    typeof event.authorityId !== "string" ||
    event.authorityId !== expectedAuthority ||
    typeof event.snapshotDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(event.snapshotDigest)
  ) {
    return null;
  }
  const digest = event.snapshotDigest;
  if (event.unchanged === true) {
    return digest === expectedDigest ? { kind: "unchanged", digest } : null;
  }
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const snapshot = data as Record<string, unknown>;
  if (!isRunState(snapshot.runState)) return null;
  const statuses = snapshot.sessionStatuses;
  if (
    !statuses ||
    typeof statuses !== "object" ||
    Array.isArray(statuses) ||
    !Object.values(statuses).every(isSessionRuntimeStatus)
  )
    return null;
  return { kind: "full", digest };
}

/**
 * Owns browser WebSocket lifetime, snapshot handshake, liveness, and backoff.
 * The AppStore host remains the sole state publisher and projection owner.
 */
export class ConnectionController {
  private socket: WebSocket | null = null;
  private socketPhase: "bootstrap" | "resume" | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private token: string | null = null;
  private started = false;
  private reconnectPending = false;
  private synchronized = false;
  private scheduledReconnectKind: "resume" | "bootstrap" | null = null;
  private lastFrameAt = 0;
  private streamUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStreamUpdate: {
    socket: WebSocket;
    event: WireEvent;
    key: string;
  } | null = null;
  private streamMetricStartedAt = -1;
  private streamMetricFrames = 0;
  private streamMetricCharacters = 0;
  private streamMetricAssistantEvents = 0;

  constructor(private readonly host: ConnectionControllerHost) {}

  connect(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.openSocket(token, "bootstrap");
  }

  private openSocket(
    token: string | null,
    phase: "bootstrap" | "resume",
  ): void {
    const handshakeStartedAt = transportNow();
    this.reconnectPending = false;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    this.synchronized = false;
    this.lastFrameAt = 0;

    const previous = this.socket;
    if (previous) {
      // Detach before close so this deliberate replacement cannot be observed
      // as an unexpected disconnect.
      this.socket = null;
      this.host.onTransportReplaced();
      previous.close();
    }
    const state = this.host.state();
    this.host.patch({
      connection: state.bootstrapped ? "reconnecting" : "connecting",
    });
    const socket = new WebSocket(
      eventsUrl(token, state.snapshotDigest ?? null),
    );
    this.socket = socket;
    this.socketPhase = phase;
    // Bound the whole connection handshake, not only an already-open socket:
    // a black-holed TCP/WebSocket negotiation may otherwise remain CONNECTING
    // indefinitely without producing an error or close event.
    this.snapshotTimer = setTimeout(
      () => this.failSocket(socket),
      FIRST_SNAPSHOT_TIMEOUT_MS,
    );
    socket.onmessage = (frame) => {
      if (this.socket !== socket) return;
      const event = parseWireEvent(frame.data);
      if (!event) {
        // Dropping an unparseable frame would leave a permanent sequence gap;
        // later heartbeats could otherwise keep that stale projection alive.
        this.failSocket(socket);
        return;
      }

      const hostState = this.host.state();
      if (!this.synchronized) {
        const snapshot = authoritativeSnapshot(
          event,
          hostState.authorityId,
          hostState.snapshotDigest,
        );
        if (!snapshot) {
          this.failSocket(socket, "bootstrap");
          return;
        }
        try {
          this.host.applyEvent(event);
          this.host.recordSnapshotDigest(snapshot.digest);
        } catch {
          this.failSocket(socket, "bootstrap");
          return;
        }
        if (this.socket !== socket) return;
        this.synchronized = true;
        this.lastFrameAt = Date.now();
        this.reconnectDelay = 1_000;
        this.scheduledReconnectKind = null;
        this.clearSnapshotTimer();
        this.armWatchdog(socket);
        this.host.patch({ connection: "open", connectionProblem: null });
        recordTransportMeasure("websocket-handshake", handshakeStartedAt, {
          phase,
          snapshot: snapshot.kind,
          compression: socket.extensions.includes("permessage-deflate"),
          characters: String(frame.data).length,
        });
        this.beginStreamMetrics();
        return;
      }

      this.lastFrameAt = Date.now();
      this.armWatchdog(socket);
      this.recordStreamFrame(event, String(frame.data).length);
      if (event.type === "heartbeat") return;
      if (event.type === "snapshot") {
        if (!this.flushStreamUpdate(socket)) return;
        const snapshot = authoritativeSnapshot(
          event,
          hostState.authorityId,
          hostState.snapshotDigest,
        );
        if (!snapshot) {
          this.failSocket(socket, "bootstrap");
          return;
        }
        if (!this.applySocketEvent(socket, event)) return;
        this.host.recordSnapshotDigest(snapshot.digest);
        return;
      }
      // Host-wide update status is carried on the authenticated stream but is
      // not part of the runtime snapshot digest.
      if (event.type !== "update_status") this.host.invalidateSnapshotDigest();
      const streamUpdate = streamMessageUpdate(event);
      if (streamUpdate) {
        this.queueStreamUpdate(socket, streamUpdate);
        return;
      }
      if (!this.flushStreamUpdate(socket)) return;
      this.applySocketEvent(socket, event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const canResume =
        this.synchronized ||
        (phase === "bootstrap" && Boolean(this.host.state().snapshotDigest));
      this.socket = null;
      this.socketPhase = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.clearStreamTimers();
      this.host.onTransportClosed();
      this.scheduleReconnectAfterDelay(
        token,
        canResume ? "resume" : "bootstrap",
      );
    };
    socket.onerror = () => socket.close();
  }

  stop(): void {
    this.started = false;
    this.token = null;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    this.synchronized = false;
    this.lastFrameAt = 0;
    const socket = this.socket;
    this.socket = null;
    this.socketPhase = null;
    socket?.close();
  }

  retry(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.socketPhase = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.host.onTransportReplaced();
      socket.close();
    }
    this.requestReconnect("bootstrap");
  }

  scheduleReconnect(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.scheduleReconnectAfterDelay(token, "bootstrap");
  }

  /** Recover promptly from browser/network lifecycle boundaries. A normal
   * visibility return keeps a recently active stream rather than churning it. */
  recover(trigger: ConnectionRecoveryTrigger): void {
    if (!this.started) return;
    if (trigger === "visible") {
      if (!this.pageVisible()) return;
      const recentlyActive =
        this.socket !== null &&
        this.synchronized &&
        Date.now() - this.lastFrameAt < RECENT_STREAM_ACTIVITY_MS;
      if (recentlyActive && this.reconnectTimer === null) return;
    }
    this.recoverNow();
  }

  private recoverNow(): void {
    if (this.reconnectPending) return;
    const canResume =
      (this.socket !== null && this.synchronized) ||
      this.scheduledReconnectKind === "resume" ||
      (this.socketPhase === "bootstrap" &&
        Boolean(this.host.state().snapshotDigest));
    this.clearReconnectTimer();
    this.clearStreamTimers();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.socketPhase = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.host.onTransportClosed();
      socket.close();
    }
    this.requestReconnect(canResume ? "resume" : "bootstrap");
  }

  private requestReconnect(kind: "resume" | "bootstrap"): void {
    if (!this.started || this.reconnectPending) return;
    this.scheduledReconnectKind = null;
    if (kind === "resume") {
      this.openSocket(this.token, "resume");
      return;
    }
    this.reconnectPending = true;
    this.host.reconnect(this.token);
  }

  private applySocketEvent(socket: WebSocket, event: WireEvent): boolean {
    if (this.socket !== socket) return false;
    try {
      this.host.applyEvent(event);
      return true;
    } catch {
      // A reducer invariant failure leaves event ordering untrustworthy.
      // Rebuild from the Host snapshot instead of keeping a partial UI.
      this.failSocket(socket);
      return false;
    }
  }

  private flushStreamUpdate(socket: WebSocket): boolean {
    if (this.streamUpdateTimer) clearTimeout(this.streamUpdateTimer);
    this.streamUpdateTimer = null;
    const pending = this.pendingStreamUpdate;
    this.pendingStreamUpdate = null;
    if (!pending || pending.socket !== socket) return this.socket === socket;
    return this.applySocketEvent(socket, pending.event);
  }

  private queueStreamUpdate(
    socket: WebSocket,
    update: { event: WireEvent; key: string; textLength: number },
  ): void {
    const pending = this.pendingStreamUpdate;
    if (
      pending &&
      (pending.socket !== socket || pending.key !== update.key) &&
      !this.flushStreamUpdate(socket)
    )
      return;
    if (
      this.pendingStreamUpdate &&
      this.pendingStreamUpdate.event.type === "message_update_batch" &&
      update.event.type === "message_update_batch"
    ) {
      const previousEvents = this.pendingStreamUpdate.event
        .assistantMessageEvents as unknown[];
      const nextEvents = update.event.assistantMessageEvents as unknown[];
      if (
        previousEvents.length + nextEvents.length >
        MAX_ASSISTANT_STREAM_BATCH_EVENTS
      ) {
        if (!this.flushStreamUpdate(socket)) return;
        this.pendingStreamUpdate = {
          socket,
          event: update.event,
          key: update.key,
        };
      } else {
        this.pendingStreamUpdate.event = {
          ...update.event,
          assistantMessageEvents: [...previousEvents, ...nextEvents],
        };
      }
    } else if (
      this.pendingStreamUpdate &&
      this.pendingStreamUpdate.event.type === "message_update" &&
      update.event.type === "message_update_batch"
    ) {
      // A complete projection followed by deltas is ordered, not
      // supersedable. Publish the complete base before retaining the batch.
      if (!this.flushStreamUpdate(socket)) return;
      this.pendingStreamUpdate = {
        socket,
        event: update.event,
        key: update.key,
      };
    } else {
      // A later complete projection subsumes any earlier queued update.
      this.pendingStreamUpdate = {
        socket,
        event: update.event,
        key: update.key,
      };
    }
    if (this.streamUpdateTimer) return;
    this.streamUpdateTimer = setTimeout(() => {
      this.streamUpdateTimer = null;
      this.flushStreamUpdate(socket);
    }, streamRenderInterval(update.textLength));
  }

  private failSocket(
    socket: WebSocket,
    recovery?: "resume" | "bootstrap",
  ): void {
    if (this.socket !== socket) return;
    const canResume =
      recovery === "resume" ||
      (recovery !== "bootstrap" &&
        (this.synchronized ||
          (this.socketPhase === "bootstrap" &&
            Boolean(this.host.state().snapshotDigest))));
    this.socket = null;
    this.socketPhase = null;
    this.synchronized = false;
    this.lastFrameAt = 0;
    this.clearStreamTimers();
    this.host.onTransportClosed();
    socket.close();
    this.scheduleReconnectAfterDelay(
      this.token,
      canResume ? "resume" : "bootstrap",
    );
  }

  private scheduleReconnectAfterDelay(
    token: string | null,
    kind: "resume" | "bootstrap",
  ): void {
    this.token = token;
    this.clearReconnectTimer();
    this.scheduledReconnectKind = kind;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.requestReconnect(kind);
    }, delay);
  }

  private armWatchdog(socket: WebSocket): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    const elapsed = Date.now() - this.lastFrameAt;
    this.watchdogTimer = setTimeout(
      () => {
        this.watchdogTimer = null;
        if (this.socket !== socket || !this.synchronized) return;
        const remaining =
          STREAM_INACTIVITY_TIMEOUT_MS - (Date.now() - this.lastFrameAt);
        if (remaining > 0) {
          this.armWatchdog(socket);
          return;
        }
        // Background tabs can suspend JavaScript timers. Their visibility
        // event performs the same stale check before work resumes.
        if (this.pageVisible()) this.recoverNow();
      },
      Math.max(0, STREAM_INACTIVITY_TIMEOUT_MS - elapsed),
    );
  }

  private pageVisible(): boolean {
    return document.visibilityState !== "hidden";
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  private beginStreamMetrics(): void {
    this.streamMetricStartedAt = transportNow();
    this.streamMetricFrames = 0;
    this.streamMetricCharacters = 0;
    this.streamMetricAssistantEvents = 0;
  }

  private recordStreamFrame(event: WireEvent, characters: number): void {
    if (this.streamMetricStartedAt < 0) this.beginStreamMetrics();
    this.streamMetricFrames += 1;
    this.streamMetricCharacters += characters;
    this.streamMetricAssistantEvents +=
      event.type === "message_update_batch" &&
      Array.isArray(event.assistantMessageEvents)
        ? event.assistantMessageEvents.length
        : event.type === "message_update"
          ? 1
          : 0;
    if (transportNow() - this.streamMetricStartedAt >= 10_000)
      this.flushStreamMetrics();
  }

  private flushStreamMetrics(): void {
    if (this.streamMetricStartedAt < 0) return;
    if (this.streamMetricFrames > 0)
      recordTransportMeasure(
        "event-stream-window",
        this.streamMetricStartedAt,
        {
          frames: this.streamMetricFrames,
          characters: this.streamMetricCharacters,
          assistantEvents: this.streamMetricAssistantEvents,
        },
      );
    this.streamMetricStartedAt = -1;
    this.streamMetricFrames = 0;
    this.streamMetricCharacters = 0;
    this.streamMetricAssistantEvents = 0;
  }

  private clearStreamTimers(): void {
    this.flushStreamMetrics();
    this.clearSnapshotTimer();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    if (this.streamUpdateTimer) clearTimeout(this.streamUpdateTimer);
    this.watchdogTimer = null;
    this.streamUpdateTimer = null;
    this.pendingStreamUpdate = null;
  }
}
