interface TerminalRingChunk {
  start: number;
  data: Buffer;
}

interface TerminalRingSlice {
  offset: number;
  data: Buffer;
}

/** A byte-exact trailing PTY history. Absolute offsets never rewind when old
 * chunks are evicted, so reconnecting clients can distinguish a fillable gap
 * from one that requires a terminal-state snapshot. */
export class TerminalRingBuffer {
  private readonly chunks: TerminalRingChunk[] = [];
  private retainedBytes = 0;
  private endOffset = 0;

  constructor(private readonly capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1)
      throw new Error("Terminal ring capacity must be a positive integer");
  }

  get firstOffset(): number {
    return this.chunks[0]?.start ?? this.endOffset;
  }

  get nextOffset(): number {
    return this.endOffset;
  }

  get size(): number {
    return this.retainedBytes;
  }

  append(value: Uint8Array): number {
    const start = this.endOffset;
    this.endOffset += value.byteLength;
    if (!Number.isSafeInteger(this.endOffset))
      throw new Error("Terminal output exceeded the safe offset range");
    if (value.byteLength === 0) return start;

    const retained =
      value.byteLength > this.capacityBytes
        ? Buffer.from(value.subarray(value.byteLength - this.capacityBytes))
        : Buffer.from(value);
    const retainedStart = this.endOffset - retained.byteLength;
    this.chunks.push({ start: retainedStart, data: retained });
    this.retainedBytes += retained.byteLength;
    this.trim();
    return start;
  }

  contains(offset: number): boolean {
    return (
      Number.isSafeInteger(offset) &&
      offset >= this.firstOffset &&
      offset <= this.endOffset
    );
  }

  slicesFrom(offset: number): TerminalRingSlice[] | null {
    if (!this.contains(offset)) return null;
    if (offset === this.endOffset) return [];
    const result: TerminalRingSlice[] = [];
    for (const chunk of this.chunks) {
      const end = chunk.start + chunk.data.byteLength;
      if (end <= offset) continue;
      const skipped = Math.max(0, offset - chunk.start);
      result.push({
        offset: chunk.start + skipped,
        data: chunk.data.subarray(skipped),
      });
    }
    return result;
  }

  clear(): void {
    this.chunks.length = 0;
    this.retainedBytes = 0;
    this.endOffset = 0;
  }

  discardRetained(): void {
    this.chunks.length = 0;
    this.retainedBytes = 0;
  }

  private trim(): void {
    while (this.retainedBytes > this.capacityBytes) {
      const first = this.chunks[0];
      if (!first) return;
      const overflow = this.retainedBytes - this.capacityBytes;
      if (first.data.byteLength <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.data.byteLength;
        continue;
      }
      first.start += overflow;
      first.data = first.data.subarray(overflow);
      this.retainedBytes -= overflow;
    }
  }
}
