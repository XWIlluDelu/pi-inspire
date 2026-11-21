const BLOCK_BYTES = 64 * 1024;

/** Retain PTY output by absolute byte offset. Fixed-size blocks keep the
 * replay cost independent of how the PTY split its writes. */
export class TerminalRingBuffer {
  private readonly blocks = new Map<number, Buffer>();
  private readonly blockBytes: number;
  private start = 0;
  private end = 0;

  constructor(private readonly capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1)
      throw new Error("Terminal ring capacity must be a positive integer");
    this.blockBytes = Math.min(BLOCK_BYTES, capacityBytes);
  }

  get nextOffset(): number {
    return this.end;
  }

  append(data: Uint8Array): number {
    const offset = this.end;
    const end = offset + data.byteLength;
    if (!Number.isSafeInteger(end))
      throw new Error("Terminal output exceeded the safe offset range");
    this.start = Math.max(this.start, end - this.capacityBytes);
    this.end = end;

    for (const index of this.blocks.keys()) {
      if (index >= Math.floor(this.start / this.blockBytes)) break;
      this.blocks.delete(index);
    }
    for (let position = Math.max(offset, this.start); position < end; ) {
      const index = Math.floor(position / this.blockBytes);
      const within = position % this.blockBytes;
      let block = this.blocks.get(index);
      if (!block) {
        block = Buffer.allocUnsafe(this.blockBytes);
        this.blocks.set(index, block);
      }
      const count = Math.min(this.blockBytes - within, end - position);
      block.set(
        data.subarray(position - offset, position - offset + count),
        within,
      );
      position += count;
    }
    return offset;
  }

  contains(offset: number): boolean {
    return (
      Number.isSafeInteger(offset) && offset >= this.start && offset <= this.end
    );
  }

  slicesFrom(offset: number): { offset: number; data: Buffer }[] | null {
    if (!this.contains(offset)) return null;
    const slices = [];
    while (offset < this.end) {
      const block = this.blocks.get(Math.floor(offset / this.blockBytes))!;
      const within = offset % this.blockBytes;
      const data = block.subarray(within, within + (this.end - offset));
      slices.push({ offset, data });
      offset += data.byteLength;
    }
    return slices;
  }

  discardRetained(): void {
    this.start = this.end;
    this.blocks.clear();
  }
}
