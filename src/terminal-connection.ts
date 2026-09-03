import type {
  TerminalAttachRequest,
  TerminalDescriptor,
  TerminalServerControlMessage,
  TerminalServerDataFrame,
} from "../shared/terminal-contracts";
import {
  decodeTerminalServerDataFrame,
  encodeTerminalInputFrame,
  MAX_TERMINAL_INPUT_BYTES,
} from "../shared/terminal-contracts";
import { type Api, terminalUrl } from "./api";

export type TerminalTransportStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

interface TerminalConnectionCallbacks {
  dimensions(): { cols: number; rows: number };
  data(frame: TerminalServerDataFrame): void;
  control(message: TerminalServerControlMessage): void;
  status(status: TerminalTransportStatus): void;
  error(message: string): void;
}

interface TerminalResumeState {
  outputEpoch?: string;
  nextOutputOffset?: number;
  resizeRevision?: number;
}

const CLIENT_ID_KEY = "inspire:terminal-client-id";
const OWNER_KEY_PREFIX = "inspire:terminal-owner:";
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const MAX_RECONNECT_DELAY_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 400;

function sessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // A privacy-restricted browser may not expose session storage. The live
    // socket remains fully functional; only seamless writer reclaim is lost.
  }
}

function terminalClientId(): string {
  const existing = sessionValue(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  setSessionValue(CLIENT_ID_KEY, id);
  return id;
}

function isServerControlMessage(
  value: unknown,
): value is TerminalServerControlMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

export class TerminalConnection {
  private socket: WebSocket | null = null;
  private stopped = true;
  private generation = 0;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: number | null = null;
  private resume: TerminalResumeState = {};
  private descriptor: TerminalDescriptor | null = null;
  private replayComplete = false;
  private writable = false;
  private nextInputSequence = 1;
  private readonly pendingInput = new Map<number, Uint8Array>();
  private pendingInputBytes = 0;
  private readonly ownerStorageKey: string;

  constructor(
    private readonly api: Api,
    private readonly terminalId: string,
    private readonly callbacks: TerminalConnectionCallbacks,
    private readonly clientId = terminalClientId(),
  ) {
    this.ownerStorageKey = `${OWNER_KEY_PREFIX}${terminalId}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.callbacks.status("connecting");
    void this.connect(++this.generation);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "Terminal view detached");
    this.callbacks.status("offline");
  }

  sendInput(value: string): boolean {
    if (!this.writable || !this.replayComplete || !this.isSocketOpen())
      return false;
    const encoded = new TextEncoder().encode(value);
    if (this.pendingInputBytes + encoded.byteLength > MAX_PENDING_INPUT_BYTES) {
      this.callbacks.error("Terminal input is waiting for acknowledgement");
      return false;
    }
    for (
      let offset = 0;
      offset < encoded.byteLength;
      offset += MAX_TERMINAL_INPUT_BYTES
    ) {
      const data = encoded.slice(
        offset,
        Math.min(encoded.byteLength, offset + MAX_TERMINAL_INPUT_BYTES),
      );
      const sequence = this.nextInputSequence++;
      this.pendingInput.set(sequence, data);
      this.pendingInputBytes += data.byteLength;
      this.socket?.send(encodeTerminalInputFrame(sequence, data));
    }
    return true;
  }

  resize(cols: number, rows: number): void {
    if (!this.writable || !this.replayComplete) return;
    this.sendControl({ type: "resize", cols, rows });
  }

  takeControl(cols: number, rows: number): void {
    if (!this.replayComplete) return;
    this.sendControl({ type: "take_control", cols, rows });
  }

  releaseControl(): void {
    this.sendControl({ type: "release_control" });
  }

  forceSnapshot(): void {
    this.resume = {};
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN)
      socket.close(1012, "Terminal state needs resynchronization");
  }

  private async connect(generation: number): Promise<void> {
    try {
      const { ticket } = await this.api.terminalAttachTicket(this.terminalId);
      if (this.stopped || generation !== this.generation) return;
      const socket = new WebSocket(terminalUrl());
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.stopped || generation !== this.generation) {
          socket.close(1000, "Stale terminal connection");
          return;
        }
        const dimensions = this.callbacks.dimensions();
        const request: TerminalAttachRequest = {
          type: "attach",
          ticket,
          clientId: this.clientId,
          ...dimensions,
          ...this.resume,
          ownerToken: sessionValue(this.ownerStorageKey) ?? undefined,
        };
        socket.send(JSON.stringify(request));
      });
      socket.addEventListener("message", (event) => {
        if (this.stopped || generation !== this.generation) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            this.receiveData(decodeTerminalServerDataFrame(event.data));
            return;
          }
          if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then((buffer) => {
              if (!this.stopped && generation === this.generation)
                this.receiveData(decodeTerminalServerDataFrame(buffer));
            });
            return;
          }
          const message = JSON.parse(String(event.data)) as unknown;
          if (!isServerControlMessage(message))
            throw new Error("Terminal control frame is invalid");
          this.receiveControl(message);
        } catch (error) {
          this.callbacks.error(
            error instanceof Error ? error.message : "Terminal data is invalid",
          );
          this.resume = {};
          socket.close(1002, "Invalid terminal protocol");
        }
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.writable = false;
        this.replayComplete = false;
        if (this.stopped || generation !== this.generation) return;
        this.callbacks.status("reconnecting");
        this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        // The close event owns retry and user-visible status.
      });
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.callbacks.error(
        error instanceof Error ? error.message : "Terminal connection failed",
      );
      this.callbacks.status("reconnecting");
      this.scheduleReconnect();
    }
  }

  private receiveData(frame: TerminalServerDataFrame): void {
    if (!this.descriptor)
      throw new Error("Terminal output arrived before attachment");
    if (frame.kind === "snapshot") {
      this.resume = {
        outputEpoch: this.descriptor.outputEpoch,
        nextOutputOffset: frame.offset,
        resizeRevision: frame.resizeRevision,
      };
      this.callbacks.data(frame);
      return;
    }
    if (frame.kind === "snapshot-continuation") {
      if (
        this.resume.nextOutputOffset === undefined ||
        frame.offset !== this.resume.nextOutputOffset ||
        frame.resizeRevision !== this.resume.resizeRevision
      ) {
        this.resume = {};
        throw new Error("Terminal snapshot continuity was lost");
      }
      this.callbacks.data(frame);
      return;
    }
    if (
      this.resume.nextOutputOffset === undefined ||
      frame.offset !== this.resume.nextOutputOffset ||
      frame.resizeRevision !== this.resume.resizeRevision
    ) {
      this.resume = {};
      throw new Error("Terminal output continuity was lost");
    }
    this.callbacks.data(frame);
    this.resume.nextOutputOffset += frame.data.byteLength;
  }

  private receiveControl(message: TerminalServerControlMessage): void {
    if (message.type === "attached") {
      if (
        this.descriptor &&
        this.descriptor.outputEpoch !== message.terminal.outputEpoch
      )
        this.clearPendingInput();
      this.descriptor = message.terminal;
      this.writable = message.writable;
      this.replayComplete = false;
      if (message.replay === "snapshot") this.resume = {};
      else {
        this.resume.outputEpoch = message.terminal.outputEpoch;
        this.resume.resizeRevision = message.terminal.resizeRevision;
      }
      this.acceptOwnerState(
        message.writable,
        message.ownerToken,
        message.nextInputSequence,
      );
      this.callbacks.status("connected");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    } else if (message.type === "replay_complete") {
      if (
        this.resume.nextOutputOffset === undefined ||
        this.resume.nextOutputOffset !== message.nextOutputOffset
      ) {
        this.resume = {};
        throw new Error("Terminal replay did not reach the live edge");
      }
      this.replayComplete = true;
      this.resendPendingInput();
    } else if (message.type === "input_ack") {
      this.acknowledgeInput(message.sequence);
    } else if (message.type === "ownership") {
      this.writable = message.writable;
      this.acceptOwnerState(
        message.writable,
        message.ownerToken,
        message.nextInputSequence,
      );
    } else if (message.type === "resized") {
      this.resume.resizeRevision = message.resizeRevision;
    } else if (message.type === "descriptor") {
      this.descriptor = message.terminal;
    } else if (message.type === "exit") {
      this.descriptor = message.terminal;
      this.writable = false;
    } else if (message.type === "error" && message.fatal) {
      this.callbacks.error(message.message);
    }
    this.callbacks.control(message);
  }

  private acceptOwnerState(
    writable: boolean,
    token: string | undefined,
    nextSequence: number | undefined,
  ): void {
    if (!writable) {
      this.clearPendingInput();
      return;
    }
    if (token) setSessionValue(this.ownerStorageKey, token);
    if (nextSequence === undefined) return;
    for (const [sequence, data] of this.pendingInput) {
      if (sequence >= nextSequence) continue;
      this.pendingInput.delete(sequence);
      this.pendingInputBytes -= data.byteLength;
    }
    if (
      this.pendingInput.size > 0 &&
      Math.min(...this.pendingInput.keys()) !== nextSequence
    ) {
      this.clearPendingInput();
    }
    this.nextInputSequence = Math.max(
      nextSequence,
      ...[...this.pendingInput.keys()].map((sequence) => sequence + 1),
    );
  }

  private acknowledgeInput(sequence: number): void {
    for (const [pendingSequence, data] of this.pendingInput) {
      if (pendingSequence > sequence) continue;
      this.pendingInput.delete(pendingSequence);
      this.pendingInputBytes -= data.byteLength;
    }
  }

  private resendPendingInput(): void {
    if (!this.writable || !this.isSocketOpen()) return;
    for (const [sequence, data] of this.pendingInput)
      this.socket?.send(encodeTerminalInputFrame(sequence, data));
  }

  private clearPendingInput(): void {
    this.pendingInput.clear();
    this.pendingInputBytes = 0;
    this.nextInputSequence = 1;
  }

  private sendControl(message: object): void {
    if (!this.isSocketOpen()) return;
    this.socket?.send(JSON.stringify(message));
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      Math.round(this.reconnectDelay * 1.7),
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connect(++this.generation);
    }, delay);
  }
}
