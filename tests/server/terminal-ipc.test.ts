import { describe, expect, it } from "vitest";
import {
  decodeTerminalIpcJson,
  encodeTerminalIpcFrame,
  encodeTerminalIpcJson,
  TERMINAL_IPC_DATA_FRAME,
  TERMINAL_IPC_JSON_FRAME,
  TerminalIpcDecoder,
} from "../../server/terminal-ipc.js";

describe("terminal IPC framing", () => {
  it("decodes fragmented and coalesced frames", () => {
    const first = encodeTerminalIpcJson({ type: "ready" });
    const second = encodeTerminalIpcFrame(
      TERMINAL_IPC_DATA_FRAME,
      Buffer.from([1, 2, 3]),
    );
    const bytes = Buffer.concat([first, second]);
    const decoder = new TerminalIpcDecoder();

    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    const frames = [
      ...decoder.push(bytes.subarray(3, 9)),
      ...decoder.push(bytes.subarray(9)),
    ];

    expect(frames).toHaveLength(2);
    expect(frames[0]?.kind).toBe(TERMINAL_IPC_JSON_FRAME);
    expect(
      decodeTerminalIpcJson(frames[0]?.payload ?? Buffer.alloc(0)),
    ).toEqual({
      type: "ready",
    });
    expect(frames[1]).toMatchObject({ kind: TERMINAL_IPC_DATA_FRAME });
    expect([
      ...((frames[1]?.payload ?? Buffer.alloc(0)) as Uint8Array),
    ]).toEqual([1, 2, 3]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects unfinished frames", () => {
    const decoder = new TerminalIpcDecoder();
    decoder.push(encodeTerminalIpcJson({ ok: true }).subarray(0, 6));
    expect(() => decoder.finish()).toThrow(/within a frame/u);
  });
});
