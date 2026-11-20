import {
  assistantStreamTextLength,
  MAX_ASSISTANT_STREAM_BATCH_EVENTS,
} from "../../shared/assistant-stream";
import {
  isSessionRuntimeStatus,
  type SessionDetailInterest,
} from "../../shared/contracts";
import { structuralMessageIdentity } from "../../shared/message-identity";
import { eventsUrl, HTTP_OBSERVATION_TIMEOUT_MS } from "../api";
import { socketTicket } from "../browser-auth";
import type { WireEvent } from "../events";
import { recordTransportMeasure } from "../transport-performance";

export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
// Snapshot projection can wait on Pi's 30-second reads. Connection setup and
// snapshot observation are separate phases; neither extends execution in Pi.
export const FIRST_SNAPSHOT_TIMEOUT_MS = HTTP_OBSERVATION_TIMEOUT_MS;
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
    Array.isArray(event.assistantMessageEvents) &&
    event.assistantMessageEvents.length > 0 &&
    typeof event.sourceEventCount === "number" &&
    Number.isSafeInteger(event.sourceEventCount) &&
    event.sourceEventCount >= event.assistantMessageEvents.length &&
    event.sourceEventCount <= MAX_ASSISTANT_STREAM_BATCH_EVENTS
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
  const textLength = assistantStreamTextLength(message);
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
type ConnectionRecoveryTrigger = "online" | "pageshow" | "visible";

interface ConnectionControllerHost {
  state(): {
    bootstrapped: boolean;
    authorityId: string | null;
    sessionId: string | null;
  };
  patch(patch: {
    connection?: ManagedConnectionState;
    connectionProblem?: ManagedConnectionProblem;
  }): void;
  applyEvent(event: WireEvent): void;
  /** A deliberate replacement invalidates ownership tied to the old stream. */
  onTransportReplaced(): void;
  /** An unexpected close invalidates stream-owned state before retrying. */
  onTransportClosed(): void;
  reconnect(): void;
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
    const wire = event as WireEvent;
    if (
      wire.sessionStatus !== undefined &&
      !isSessionRuntimeStatus(wire.sessionStatus)
    )
      return null;
    return wire;
  } catch {
    return null;
  }
}

function isAuthoritativeSnapshot(
  event: WireEvent,
  authorityId: string | null,
): boolean {
  if (
    event.type !== "snapshot" ||
    !authorityId ||
    event.authorityId !== authorityId ||
    typeof event.detailRevision !== "number" ||
    !Number.isSafeInteger(event.detailRevision) ||
    event.detailRevision < 0 ||
    (event.detailSessionId !== null &&
      typeof event.detailSessionId !== "string")
  )
    return false;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const { sessionStatuses, active } = data as Record<string, unknown>;
  const activeId =
    active && typeof active === "object"
      ? (active as { sessionId?: unknown }).sessionId
      : null;
  return (
    (active === null ||
      (typeof active === "object" &&
        active !== null &&
        !Array.isArray(active))) &&
    (event.missingDetail === true
      ? active === null && typeof event.detailSessionId === "string"
      : activeId === event.detailSessionId) &&
    sessionStatuses !== null &&
    typeof sessionStatuses === "object" &&
    !Array.isArray(sessionStatuses) &&
    (typeof activeId !== "string" ||
      Object.hasOwn(sessionStatuses, activeId)) &&
    Object.values(sessionStatuses).every(isSessionRuntimeStatus)
  );
}

/**
 * Owns browser WebSocket lifetime, snapshot handshake, liveness, and backoff.
 * The AppStore host remains the sole state publisher and projection owner.
 */
export class ConnectionController {
  private socket: WebSocket | null = null;
  private socketRequest = 0;
  private socketPhase: "bootstrap" | "resume" | null = null;
  private detailSessionId: string | null = null;
  private detailRevision = 0;
  private wantedDetailSessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
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

  connect(sessionId = this.host.state().sessionId): Promise<void> {
    this.started = true;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.wantedDetailSessionId = sessionId;
    return this.openSocket("bootstrap");
  }

  /** Selection commits keep the global stream alive, but fence its detail
   * projection behind a new addressed snapshot. */
  updateDetailInterest(sessionId = this.host.state().sessionId): void {
    this.wantedDetailSessionId = sessionId;
    this.sendDetailInterest();
  }

  private sendDetailInterest(): void {
    const socket = this.socket;
    const sessionId = this.wantedDetailSessionId;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      sessionId === this.detailSessionId
    )
      return;
    this.detailSessionId = sessionId;
    this.detailRevision += 1;
    if (this.streamUpdateTimer) clearTimeout(this.streamUpdateTimer);
    this.streamUpdateTimer = null;
    this.pendingStreamUpdate = null;
    const interest: SessionDetailInterest = {
      type: "detail_interest",
      sessionId,
      revision: this.detailRevision,
    };
    try {
      socket.send(JSON.stringify(interest));
    } catch {
      this.failSocket(socket);
      return;
    }
    this.clearSnapshotTimer();
    this.snapshotTimer = setTimeout(
      () => this.failSocket(socket),
      FIRST_SNAPSHOT_TIMEOUT_MS,
    );
  }

  private async openSocket(phase: "bootstrap" | "resume"): Promise<void> {
    const request = ++this.socketRequest;
    const handshakeStartedAt = performance.now();
    this.reconnectPending = false;
    this.clearReconnectTimer();
    this.retireSocket("replaced");
    let ticket: string;
    try {
      ticket = await socketTicket("events");
    } catch {
      if (this.started && request === this.socketRequest)
        this.scheduleReconnectAfterDelay("bootstrap");
      return;
    }
    if (!this.started || request !== this.socketRequest) return;
    const state = this.host.state();
    this.host.patch({
      connection: state.bootstrapped ? "reconnecting" : "connecting",
    });
    this.detailSessionId = this.wantedDetailSessionId;
    this.detailRevision = 0;
    const socket = new WebSocket(eventsUrl(ticket, this.detailSessionId));
    this.socket = socket;
    this.socketPhase = phase;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.clearSnapshotTimer();
      this.snapshotTimer = setTimeout(
        () => this.failSocket(socket),
        FIRST_SNAPSHOT_TIMEOUT_MS,
      );
      this.sendDetailInterest();
    };
    // TCP/WebSocket negotiation must also be bounded when no open/error/close
    // event arrives. An open socket gets its own snapshot observation budget.
    this.snapshotTimer = setTimeout(
      () => this.failSocket(socket),
      SOCKET_CONNECT_TIMEOUT_MS,
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

      if (event.type === "snapshot") {
        if (!isAuthoritativeSnapshot(event, this.host.state().authorityId)) {
          this.failSocket(socket, "bootstrap");
          return;
        }
        // A snapshot already in flight for an old interest cannot replace a
        // selection the browser committed while that read was pending.
        if (
          event.detailRevision !== this.detailRevision ||
          event.detailSessionId !== this.detailSessionId ||
          this.detailSessionId !== this.wantedDetailSessionId
        )
          return;
        const first = !this.synchronized;
        if (!this.flushStreamUpdate(socket)) return;
        if (event.missingDetail === true) {
          this.detailSessionId = null;
          this.wantedDetailSessionId = null;
        }
        if (!this.applySocketEvent(socket, event) || this.socket !== socket)
          return;
        this.synchronized = true;
        this.lastFrameAt = Date.now();
        this.clearSnapshotTimer();
        this.armWatchdog(socket);
        if (first) {
          this.reconnectDelay = 1_000;
          this.scheduledReconnectKind = null;
          this.host.patch({ connection: "open", connectionProblem: null });
          recordTransportMeasure("websocket-handshake", handshakeStartedAt, {
            phase,
            compression: socket.extensions.includes("permessage-deflate"),
            characters: String(frame.data).length,
          });
          this.beginStreamMetrics();
        }
        return;
      }
      if (!this.synchronized) {
        this.failSocket(socket, "bootstrap");
        return;
      }
      this.lastFrameAt = Date.now();
      this.armWatchdog(socket);
      this.recordStreamFrame(event, String(frame.data).length);
      if (event.type === "heartbeat") return;
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
      const resume = this.canResume();
      this.retireSocket("remote");
      this.scheduleReconnectAfterDelay(resume ? "resume" : "bootstrap");
    };
    socket.onerror = () => this.failSocket(socket);
  }

  stop(): void {
    this.socketRequest += 1;
    this.started = false;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.retireSocket("stop");
  }

  retry(): void {
    this.started = true;
    this.reconnectPending = false;
    this.scheduledReconnectKind = null;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.retireSocket("replaced");
    this.requestReconnect("bootstrap");
  }

  scheduleReconnect(): void {
    this.started = true;
    this.reconnectPending = false;
    this.scheduleReconnectAfterDelay("bootstrap");
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
    const resume = this.canResume() || this.scheduledReconnectKind === "resume";
    this.clearReconnectTimer();
    this.retireSocket("interrupted");
    this.requestReconnect(resume ? "resume" : "bootstrap");
  }

  private canResume(): boolean {
    return this.synchronized || this.socketPhase === "bootstrap";
  }

  private retireSocket(
    reason: "stop" | "replaced" | "remote" | "interrupted",
  ): void {
    const socket = this.socket;
    this.socket = null;
    this.socketPhase = null;
    this.synchronized = false;
    this.lastFrameAt = 0;
    this.clearStreamTimers();
    if (!socket) return;
    if (reason === "replaced") this.host.onTransportReplaced();
    if (reason === "remote" || reason === "interrupted")
      this.host.onTransportClosed();
    if (reason !== "remote") socket.close();
  }

  private requestReconnect(kind: "resume" | "bootstrap"): void {
    if (!this.started || this.reconnectPending) return;
    this.scheduledReconnectKind = null;
    if (kind === "resume") {
      void this.openSocket("resume");
      return;
    }
    this.reconnectPending = true;
    this.host.reconnect();
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
      const sourceEventCount =
        Number(this.pendingStreamUpdate.event.sourceEventCount) +
        Number(update.event.sourceEventCount);
      if (sourceEventCount > MAX_ASSISTANT_STREAM_BATCH_EVENTS) {
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
          sourceEventCount,
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
    const kind = recovery ?? (this.canResume() ? "resume" : "bootstrap");
    this.retireSocket("interrupted");
    this.scheduleReconnectAfterDelay(kind);
  }

  private scheduleReconnectAfterDelay(kind: "resume" | "bootstrap"): void {
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
    this.streamMetricStartedAt = performance.now();
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
    if (performance.now() - this.streamMetricStartedAt >= 10_000)
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
