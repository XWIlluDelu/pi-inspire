import { describe, expect, it } from "vitest";
import {
  decodeTerminalInputFrame,
  decodeTerminalServerDataFrame,
  encodeTerminalInputFrame,
  encodeTerminalServerDataFrame,
  MAX_TERMINAL_INPUT_BYTES,
} from "../../shared/terminal-contracts";

describe("terminal binary contracts", () => {
  it("round-trips byte-preserving sequenced input", () => {
    const data = Uint8Array.from([0, 13, 27, 195, 169, 255]);
    const decoded = decodeTerminalInputFrame(
      encodeTerminalInputFrame(42, data),
    );

    expect(decoded.sequence).toBe(42);
    expect([...decoded.data]).toEqual([...data]);
  });

  it.each(["output", "snapshot", "snapshot-continuation"] as const)(
    "round-trips %s with an absolute output offset",
    (kind) => {
      const data = Uint8Array.from([27, 91, 50, 74]);
      const decoded = decodeTerminalServerDataFrame(
        encodeTerminalServerDataFrame(kind, 7, 9_007_199, data),
      );

      expect(decoded).toMatchObject({
        kind,
        resizeRevision: 7,
        offset: 9_007_199,
      });
      expect([...decoded.data]).toEqual([...data]);
    },
  );

  it("rejects malformed, empty, and oversized input frames", () => {
    expect(() => decodeTerminalInputFrame(new Uint8Array([1]))).toThrow();
    expect(() => encodeTerminalInputFrame(0, Uint8Array.of(1))).toThrow();
    expect(() =>
      encodeTerminalInputFrame(1, new Uint8Array(MAX_TERMINAL_INPUT_BYTES + 1)),
    ).toThrow();
    expect(() =>
      decodeTerminalInputFrame(Uint8Array.from([9, 0, 0, 0, 1, 1])),
    ).toThrow();
  });

  it("rejects malformed server frames and unsafe offsets", () => {
    expect(() => decodeTerminalServerDataFrame(new Uint8Array(12))).toThrow();
    expect(() =>
      encodeTerminalServerDataFrame("output", -1, 0, Uint8Array.of(1)),
    ).toThrow();
    expect(() =>
      encodeTerminalServerDataFrame(
        "output",
        0,
        Number.MAX_SAFE_INTEGER + 1,
        Uint8Array.of(1),
      ),
    ).toThrow();
  });
});
