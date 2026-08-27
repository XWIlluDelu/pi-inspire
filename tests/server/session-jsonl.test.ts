import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { JsonlObjectDecoder } from "../../server/session-jsonl.js";

describe("JsonlObjectDecoder", () => {
  it("owns an unfinished frame when the caller reuses its read buffer", () => {
    const frames: Buffer[] = [];
    const decoder = new JsonlObjectDecoder((frame) => {
      frames.push(Buffer.from(frame));
    });
    const buffer = Buffer.alloc(16);

    let length = buffer.write('{"value"');
    expect(decoder.push(buffer.subarray(0, length))).toEqual([]);

    length = buffer.write(':"ok"}\n');
    expect(decoder.push(buffer.subarray(0, length))).toEqual([{ value: "ok" }]);
    expect(Buffer.concat(frames).toString("utf8")).toBe('{"value":"ok"}\n');
  });
});
