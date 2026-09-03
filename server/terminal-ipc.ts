const IPC_HEADER_BYTES = 5;
const MAX_IPC_FRAME_BYTES = 16 * 1024 * 1024;

export const TERMINAL_IPC_JSON_FRAME = 1;
export const TERMINAL_IPC_DATA_FRAME = 2;
export const TERMINAL_IPC_INPUT_FRAME = 3;

export interface TerminalIpcFrame {
  kind: number;
  payload: Buffer;
}

export function encodeTerminalIpcFrame(
  kind: number,
  payload: string | Uint8Array,
): Buffer {
  if (!Number.isInteger(kind) || kind < 1 || kind > 255)
    throw new Error("Terminal IPC frame kind is invalid");
  const data =
    typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  if (data.byteLength > MAX_IPC_FRAME_BYTES)
    throw new Error("Terminal IPC frame exceeds its size limit");
  const frame = Buffer.allocUnsafe(IPC_HEADER_BYTES + data.byteLength);
  frame.writeUInt32BE(data.byteLength + 1, 0);
  frame.writeUInt8(kind, 4);
  data.copy(frame, IPC_HEADER_BYTES);
  return frame;
}

export class TerminalIpcDecoder {
  private buffered = Buffer.alloc(0);

  push(value: Uint8Array): TerminalIpcFrame[] {
    const incoming = Buffer.from(value);
    this.buffered =
      this.buffered.byteLength === 0
        ? incoming
        : Buffer.concat([this.buffered, incoming]);
    const frames: TerminalIpcFrame[] = [];
    while (this.buffered.byteLength >= IPC_HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_IPC_FRAME_BYTES + 1)
        throw new Error("Terminal IPC frame length is invalid");
      const total = 4 + length;
      if (this.buffered.byteLength < total) break;
      frames.push({
        kind: this.buffered.readUInt8(4),
        payload: this.buffered.subarray(IPC_HEADER_BYTES, total),
      });
      this.buffered = this.buffered.subarray(total);
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0)
      throw new Error("Terminal IPC stream ended within a frame");
  }
}

export function encodeTerminalIpcJson(value: unknown): Buffer {
  return encodeTerminalIpcFrame(TERMINAL_IPC_JSON_FRAME, JSON.stringify(value));
}

export function decodeTerminalIpcJson(payload: Buffer): unknown {
  return JSON.parse(payload.toString("utf8")) as unknown;
}
