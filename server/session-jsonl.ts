import { Buffer } from "node:buffer";

/** Persisted JSONL and child RPC frames are independent trust boundaries. */
export const MAX_PERSISTED_ENTRY_BYTES = 32 * 1024 * 1024;

function decodeJsonlObject(line: Buffer): Record<string, unknown> {
  if (line.length === 0)
    throw new Error("Persisted session contains an empty JSONL entry");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch (error) {
    throw new Error(
      `Persisted session contains a malformed complete JSONL entry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted session entry must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Incrementally frames complete JSONL objects without repeatedly copying an
 * unfinished large line. A non-LF tail remains unparsed for the next read.
 */
export class JsonlObjectDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly onFrame: (frame: Buffer) => void) {}

  tail(): Buffer {
    if (this.pendingBytes === 0) return Buffer.alloc(0);
    return Buffer.concat(this.pending, this.pendingBytes);
  }

  push(chunk: Buffer): Record<string, unknown>[] {
    const values: Record<string, unknown>[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(0x0a, offset);
      if (lf === -1) {
        const remainder = chunk.subarray(offset);
        this.pending.push(remainder);
        this.pendingBytes += remainder.length;
        if (this.pendingBytes > MAX_PERSISTED_ENTRY_BYTES)
          throw new Error(
            `Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`,
          );
        break;
      }

      const terminal = chunk.subarray(offset, lf + 1);
      const frame =
        this.pendingBytes === 0
          ? terminal
          : Buffer.concat(
              [...this.pending, terminal],
              this.pendingBytes + terminal.length,
            );
      const lineLength = frame.length - 1;
      if (lineLength > MAX_PERSISTED_ENTRY_BYTES)
        throw new Error(
          `Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`,
        );
      this.onFrame(frame);
      values.push(decodeJsonlObject(frame.subarray(0, lineLength)));
      this.pending = [];
      this.pendingBytes = 0;
      offset = lf + 1;
    }
    return values;
  }
}
