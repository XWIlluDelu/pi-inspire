import { describe, expect, it } from "vitest";
import { TerminalRingBuffer } from "../../server/terminal-ring-buffer.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("TerminalRingBuffer", () => {
  it("replays retained bytes with absolute offsets after eviction", () => {
    const ring = new TerminalRingBuffer(5);
    ring.append(bytes(1, 2, 3));
    expect(ring.append(bytes(4, 5, 6, 7))).toBe(3);

    expect(ring.slicesFrom(1)).toBeNull();
    expect(
      ring.slicesFrom(2)?.map((slice) => [slice.offset, [...slice.data]]),
    ).toEqual([
      [2, [3]],
      [3, [4, 5, 6, 7]],
    ]);
    expect(ring.slicesFrom(7)).toEqual([]);
  });

  it("keeps the suffix of a single chunk larger than capacity", () => {
    const ring = new TerminalRingBuffer(3);
    ring.append(bytes(1, 2, 3, 4, 5));
    expect(ring.slicesFrom(1)).toBeNull();
    expect(ring.slicesFrom(2)).toEqual([
      { offset: 2, data: Buffer.from([3, 4, 5]) },
    ]);
  });

  it("can discard stale-grid bytes without rewinding offsets", () => {
    const ring = new TerminalRingBuffer(8);
    ring.append(bytes(1, 2, 3));
    ring.discardRetained();

    expect(ring.slicesFrom(2)).toBeNull();
    expect(ring.append(bytes(4))).toBe(3);
    expect(ring.slicesFrom(3)).toEqual([{ offset: 3, data: Buffer.from([4]) }]);
  });
});
