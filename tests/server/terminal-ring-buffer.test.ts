import { describe, expect, it } from "vitest";
import { TerminalRingBuffer } from "../../server/terminal-ring-buffer.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("TerminalRingBuffer", () => {
  it("retains byte-exact chunks with absolute offsets", () => {
    const ring = new TerminalRingBuffer(8);
    expect(ring.append(bytes(1, 2, 3))).toBe(0);
    expect(ring.append(bytes(4, 5))).toBe(3);

    expect(ring.firstOffset).toBe(0);
    expect(ring.nextOffset).toBe(5);
    expect(
      ring.slicesFrom(2)?.map((slice) => [slice.offset, [...slice.data]]),
    ).toEqual([
      [2, [3]],
      [3, [4, 5]],
    ]);
  });

  it("evicts only the oldest bytes and reports unfillable gaps", () => {
    const ring = new TerminalRingBuffer(5);
    ring.append(bytes(1, 2, 3));
    ring.append(bytes(4, 5, 6, 7));

    expect(ring.firstOffset).toBe(2);
    expect(ring.nextOffset).toBe(7);
    expect(ring.slicesFrom(1)).toBeNull();
    expect(ring.slicesFrom(2)?.flatMap((slice) => [...slice.data])).toEqual([
      3, 4, 5, 6, 7,
    ]);
  });

  it("keeps the suffix of a single chunk larger than capacity", () => {
    const ring = new TerminalRingBuffer(3);
    expect(ring.append(bytes(1, 2, 3, 4, 5))).toBe(0);

    expect(ring.firstOffset).toBe(2);
    expect(ring.nextOffset).toBe(5);
    expect(ring.size).toBe(3);
    expect(ring.slicesFrom(2)?.[0]?.data).toEqual(Buffer.from([3, 4, 5]));
  });

  it("accepts reconnecting exactly at the live edge", () => {
    const ring = new TerminalRingBuffer(3);
    ring.append(bytes(1, 2, 3, 4));

    expect(ring.contains(4)).toBe(true);
    expect(ring.slicesFrom(4)).toEqual([]);
  });

  it("can discard stale-grid bytes without rewinding offsets", () => {
    const ring = new TerminalRingBuffer(8);
    ring.append(bytes(1, 2, 3));
    ring.discardRetained();

    expect(ring.firstOffset).toBe(3);
    expect(ring.nextOffset).toBe(3);
    expect(ring.slicesFrom(2)).toBeNull();
    expect(ring.slicesFrom(3)).toEqual([]);
    expect(ring.append(bytes(4))).toBe(3);
  });
});
