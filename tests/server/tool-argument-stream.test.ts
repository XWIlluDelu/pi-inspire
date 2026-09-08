import { describe, expect, it } from "vitest";
import { ToolArgumentStream } from "../../server/tool-argument-stream.js";
import { projectSafeValue } from "../../server/safe-projection.js";
import {
  applyToolArgumentUpdates,
  MAX_TOOL_ARGUMENT_PREVIEW_CHARS,
  type ToolArgumentUpdate,
} from "../../shared/tool-argument-updates.js";

function project(source: string, chunkSize = 1) {
  const parser = new ToolArgumentStream();
  let value: unknown = {};
  const patches: ToolArgumentUpdate[] = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    const updates = parser.feed(source.slice(index, index + chunkSize));
    patches.push(...updates);
    value = applyToolArgumentUpdates(value, updates);
    expect(value).not.toBeNull();
  }
  return { value, parser, patches };
}

describe("bounded incremental tool argument projection", () => {
  it.each([1, 2, 7, 4096])(
    "decodes strings, escapes, arrays, nested edits and primitives in %i-character chunks",
    (size) => {
      const value = {
        path: "src/中文😀.ts",
        content: 'one\n"two"\\three\t\r\b\f\u0000',
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "", newText: "😀" },
        ],
        nested: {
          truth: true,
          lie: false,
          empty: null,
          number: -1.25e4,
          list: [0, "x", [], {}],
        },
      };
      const result = project(JSON.stringify(value), size);
      expect(result.value).toEqual(value);
      expect(result.parser.truncated).toBe(false);
      expect(
        project('{"content":"\\uD83D\\uDE00\\u4e2d"}', size).value,
      ).toEqual({ content: "😀中" });
    },
  );

  it("exposes partial strings immediately, never fabricates unfinished scalar values", () => {
    const parser = new ToolArgumentStream();
    let value = applyToolArgumentUpdates(
      {},
      parser.feed('{"path":"src/file.ts","content":"first\\nsec'),
    );
    expect(value).toEqual({ path: "src/file.ts", content: "first\nsec" });
    value = applyToolArgumentUpdates(value, parser.feed('ond","timeout":1e'));
    expect(value).toEqual({ path: "src/file.ts", content: "first\nsecond" });
    value = applyToolArgumentUpdates(value, parser.feed("2}"));
    expect(value).toEqual({
      path: "src/file.ts",
      content: "first\nsecond",
      timeout: 100,
    });
  });

  it("redacts sensitive values before emitting any part, including escaped keys and nested containers", () => {
    const source =
      '{"api\\u004bey":"never-send-1","nested":{"password":{"content":"never-send-2"}},"TOKEN":["never-send-3"],"content":"safe"}';
    const result = project(source);
    expect(JSON.stringify(result.patches)).not.toContain("never-send");
    expect(result.value).toEqual(
      projectSafeValue(JSON.parse(source), {
        depth: 16,
        stringChars: 64_000,
        arrayItems: 256,
        objectEntries: 256,
      }),
    );
    expect(result.parser.characters).toBe(4);
  });

  it("keeps prototype-shaped keys as inert data and never mutates previous snapshots", () => {
    const result = project(
      '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"x":1}}}',
    );
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(result.value!, "__proto__")).toBe(true);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    const first = { content: "first", nested: { x: 1 } };
    const next = applyToolArgumentUpdates(first, [
      { path: ["content"], append: " second" },
    ]);
    expect(next).toEqual({ content: "first second", nested: { x: 1 } });
    expect(first.content).toBe("first");
    expect(
      applyToolArgumentUpdates({}, [
        { path: ["__proto__", "polluted"], set: true },
      ]),
    ).toBeNull();
  });

  it("bounds large writes and ceases updates after the explicit preview limit", () => {
    const parser = new ToolArgumentStream();
    const value = applyToolArgumentUpdates(
      {},
      parser.feed('{"content":"' + "x".repeat(1_000_000)),
    );
    expect(value).toEqual({
      content: "x".repeat(MAX_TOOL_ARGUMENT_PREVIEW_CHARS),
    });
    expect(parser.characters).toBe(MAX_TOOL_ARGUMENT_PREVIEW_CHARS);
    expect(parser.truncated).toBe(true);
    expect(parser.feed('remaining"}')).toEqual([]);
    expect(parser.feed("x".repeat(1_000_000))).toEqual([]);
  });

  it.each([
    '{"content":"bad\\q',
    '{"content":"\\uXX',
    '{"x":NaN}',
    '{"x":1e}',
    '{"x":true,}',
    '{"x":[1,]}',
    "[]",
    '{"x":' + "[".repeat(20),
    '{"' + "k".repeat(257),
    JSON.stringify(
      Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`x${n}`, n])),
    ),
    '{"token":"' + "s".repeat(260_000),
  ])(
    "stops malformed or structurally excessive previews without throwing (%s)",
    (source) => {
      const parser = new ToolArgumentStream();
      expect(() =>
        applyToolArgumentUpdates({}, parser.feed(source)),
      ).not.toThrow();
      expect(parser.truncated).toBe(true);
    },
  );
});
