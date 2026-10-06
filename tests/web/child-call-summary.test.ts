import { expect, it } from "vitest";
import { childCallSummary } from "../../src/child-call-summary";

const call = { key: "test", name: "edit", status: "ok" as const };
const preview = (argumentsPreview: string) =>
  childCallSummary({ ...call, argumentsPreview });

it("summarizes intact arguments and native model identities without changing path values", () => {
  expect(
    childCallSummary({
      ...call,
      arguments: { path: "src/app.tsx", edits: [] },
    }),
  ).toEqual({ text: "src/app.tsx", path: true });
  expect(preview('{"command":"npm run typecheck\\nnpm run build"}').text).toBe(
    "npm run typecheck",
  );
  expect(preview('{"drop":"1","quiet":true}').text).toBe(
    "drop: 1 · quiet: true",
  );
  expect(
    childCallSummary({
      ...call,
      name: "models.classify",
      argumentsPreview: "fixture/classifier",
    }).text,
  ).toBe("fixture/classifier");
});

it("recovers complete root fields before a truncated suffix, respecting escaped strings and nesting", () => {
  const path = 'C:\\project\\quoted "file".tsx';
  const args = JSON.stringify({
    path,
    edits: [{ oldText: "a".repeat(300), newText: "new" }],
  }).slice(0, 200);
  expect(preview(args)).toEqual({ text: path, path: true });
  expect(
    preview(
      '{"edits":[{"path":"nested-decoy"}],"path":"real.ts","newText":"cut',
    ),
  ).toEqual({ text: "real.ts", path: true });
  expect(preview('{"path":"real.ts","unfinishedKey"')).toEqual({
    text: "real.ts",
    path: true,
  });
  expect(preview('{"path":"real.ts"')).toEqual({ text: "real.ts", path: true });
});

it("omits incomplete values and nested lookalikes instead of exposing broken JSON or guessing parameters", () => {
  for (const args of [
    '{"path":"unfinished',
    '{"edits":[{"path":"not-the-target","oldText":"cut',
    '{"oldText":"fake \\"path\\":\\"wrong.ts\\"',
    '{"path":"invalid\\q","edits":[',
    '{"count":12',
    "not JSON",
  ])
    expect(preview(args).text).toBe("");
});
