import { eventsUrl } from "../api";
import type { WireEvent } from "../events";

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

export interface ConnectionControllerHost {
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

/**
 * Owns browser WebSocket lifetime and backoff only. The AppStore host remains
 * the sole state publisher and decides how a lost stream affects projections,
 * branch actions, and attention.
 */
export class ConnectionController {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;

  constructor(private readonly host: ConnectionControllerHost) {}

  connect(token: string | null): void {
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
      this.reconnectDelay = 1_000;
      // The host pushes an authoritative snapshot as the first frame, so no
      // redundant HTTP resync is necessary here.
      this.host.patch({ connection: "open", connectionProblem: null });
    };
    socket.onmessage = (frame) => {
      if (this.socket !== socket) return;
      try {
        this.host.applyEvent(JSON.parse(String(frame.data)) as WireEvent);
      } catch {
        // Ignore malformed transport frames; the next valid snapshot resyncs.
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.host.onTransportClosed();
      this.scheduleReconnectAfterDelay(token);
    };
    socket.onerror = () => socket.close();
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  retry(token: string | null): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = 1_000;
    this.host.reconnect(token);
  }

  scheduleReconnect(token: string | null): void {
    this.scheduleReconnectAfterDelay(token);
  }

  private scheduleReconnectAfterDelay(token: string | null): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.host.reconnect(token);
    }, delay);
  }
}
