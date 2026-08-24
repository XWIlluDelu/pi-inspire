import { structuralMessageIdentity } from "../../shared/message-identity";
import { eventsUrl } from "../api";
import type { WireEvent } from "../events";

export const FIRST_SNAPSHOT_TIMEOUT_MS = 10_000;
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;
const SHORT_STREAM_RENDER_INTERVAL_MS = 16;
const MEDIUM_STREAM_RENDER_INTERVAL_MS = 32;
const LONG_STREAM_RENDER_INTERVAL_MS = 50;
const RECENT_STREAM_ACTIVITY_MS = 30_000;

function completeMessageUpdate(
  event: WireEvent,
): { event: WireEvent; key: string; textLength: number } | null {
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
            const text = (part as Record<string, unknown>).text;
            return total + (typeof text === "string" ? text.length : 0);
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
  | { kind: "host-unreachable" }
  | { kind: "host-error"; message: string }
  | { kind: "stream-interrupted" }
  | null;
export type ConnectionRecoveryTrigger = "online" | "pageshow" | "visible";

interface ConnectionControllerHost {
  state(): { bootstrapped: boolean };
  patch(patch: {
    connection?: ManagedConnectionState;
    connectionProblem?: ManagedConnectionProblem;
  }): void;
  applyEvent(event: WireEvent): void;
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

function isAuthoritativeSnapshot(event: WireEvent): boolean {
  if (event.type !== "snapshot") return false;
  const data = event.data;
  return Boolean(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof (data as { runState?: unknown }).runState === "string" &&
      (data as { sessionStatuses?: unknown }).sessionStatuses &&
      typeof (data as { sessionStatuses?: unknown }).sessionStatuses ===
        "object" &&
      !Array.isArray((data as { sessionStatuses?: unknown }).sessionStatuses),
  );
}

/**
 * Owns browser WebSocket lifetime, snapshot handshake, liveness, and backoff.
 * The AppStore host remains the sole state publisher and projection owner.
 */
export class ConnectionController {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private token: string | null = null;
  private started = false;
  private reconnectPending = false;
  private synchronized = false;
  private lastFrameAt = 0;
  private streamUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStreamUpdate: {
    socket: WebSocket;
    event: WireEvent;
    key: string;
  } | null = null;

  constructor(private readonly host: ConnectionControllerHost) {}

  connect(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    this.synchronized = false;
    this.lastFrameAt = 0;

    const previous = this.socket;
    if (previous) {
      // Detach before close: an eager test double must not synchronously turn
      // this deliberate replacement into an unexpected reconnect.
      this.socket = null;
      this.host.onTransportReplaced();
      previous.close();
    }
    this.host.patch({
      connection: this.host.state().bootstrapped
        ? "reconnecting"
        : "connecting",
    });
    const socket = new WebSocket(eventsUrl(token));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.clearSnapshotTimer();
      this.snapshotTimer = setTimeout(
        () => this.failSocket(socket),
        FIRST_SNAPSHOT_TIMEOUT_MS,
      );
    };
    socket.onmessage = (frame) => {
      if (this.socket !== socket) return;
      const event = parseWireEvent(frame.data);
      if (!event) return;

      if (!this.synchronized) {
        if (!isAuthoritativeSnapshot(event)) {
          this.failSocket(socket);
          return;
        }
        try {
          this.host.applyEvent(event);
        } catch {
          this.failSocket(socket);
          return;
        }
        if (this.socket !== socket) return;
        this.synchronized = true;
        this.lastFrameAt = Date.now();
        this.reconnectDelay = 1_000;
        this.clearSnapshotTimer();
        this.armWatchdog(socket);
        this.host.patch({ connection: "open", connectionProblem: null });
        return;
      }

      this.lastFrameAt = Date.now();
      this.armWatchdog(socket);
      if (event.type === "heartbeat") return;
      const streamUpdate = completeMessageUpdate(event);
      if (streamUpdate) {
        this.queueStreamUpdate(socket, streamUpdate);
        return;
      }
      if (!this.flushStreamUpdate(socket)) return;
      this.applySocketEvent(socket, event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.clearStreamTimers();
      this.host.onTransportClosed();
      this.scheduleReconnectAfterDelay(token);
    };
    socket.onerror = () => socket.close();
  }

  stop(): void {
    this.started = false;
    this.token = null;
    this.reconnectPending = false;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    this.synchronized = false;
    this.lastFrameAt = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  retry(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.reconnectDelay = 1_000;
    this.clearReconnectTimer();
    this.clearStreamTimers();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.host.onTransportReplaced();
      socket.close();
    }
    this.requestReconnect();
  }

  scheduleReconnect(token: string | null): void {
    this.started = true;
    this.token = token;
    this.reconnectPending = false;
    this.scheduleReconnectAfterDelay(token);
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
    this.clearReconnectTimer();
    this.clearStreamTimers();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.synchronized = false;
      this.lastFrameAt = 0;
      this.host.onTransportClosed();
      socket.close();
    }
    this.requestReconnect();
  }

  private requestReconnect(): void {
    if (!this.started || this.reconnectPending) return;
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
    if (
      this.pendingStreamUpdate &&
      (this.pendingStreamUpdate.socket !== socket ||
        this.pendingStreamUpdate.key !== update.key) &&
      !this.flushStreamUpdate(socket)
    )
      return;
    this.pendingStreamUpdate = {
      socket,
      event: update.event,
      key: update.key,
    };
    if (this.streamUpdateTimer) return;
    this.streamUpdateTimer = setTimeout(() => {
      this.streamUpdateTimer = null;
      this.flushStreamUpdate(socket);
    }, streamRenderInterval(update.textLength));
  }

  private failSocket(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.synchronized = false;
    this.lastFrameAt = 0;
    this.clearStreamTimers();
    this.host.onTransportClosed();
    socket.close();
    this.scheduleReconnectAfterDelay(this.token);
  }

  private scheduleReconnectAfterDelay(token: string | null): void {
    this.token = token;
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.requestReconnect();
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
    return (
      typeof document === "undefined" || document.visibilityState !== "hidden"
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  private clearStreamTimers(): void {
    this.clearSnapshotTimer();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    if (this.streamUpdateTimer) clearTimeout(this.streamUpdateTimer);
    this.watchdogTimer = null;
    this.streamUpdateTimer = null;
    this.pendingStreamUpdate = null;
  }
}
