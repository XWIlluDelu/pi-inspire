import { expect, it } from "vitest";
import { TerminalRingBuffer } from "../../server/terminal-ring-buffer.js";

it("replays contiguous bytes at absolute offsets across eviction, oversized writes, and resize", () => {
  const ring = new TerminalRingBuffer(5);
  function replay(offset: number) {
    const slices = ring.slicesFrom(offset);
    return (
      slices &&
      Buffer.concat(
        slices.map((slice) => {
          expect(slice.offset).toBe(offset);
          offset += slice.data.byteLength;
          return slice.data;
        }),
      ).toString()
    );
  }

  ring.append(Buffer.from("abc"));
  expect(ring.append(Buffer.from("defg"))).toBe(3);
  expect(replay(1)).toBeNull();
  expect(replay(2)).toBe("cdefg");
  expect(replay(4)).toBe("efg");
  expect(replay(7)).toBe("");

  ring.append(Buffer.from("123456789"));
  expect(replay(10)).toBeNull();
  expect(replay(11)).toBe("56789");
  ring.discardRetained();
  expect(replay(15)).toBeNull();
  expect(ring.append(Buffer.from("z"))).toBe(16);
  expect(replay(16)).toBe("z");
});
