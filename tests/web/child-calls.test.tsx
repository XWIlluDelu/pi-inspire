// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { codemodeCalls } from "../../shared/tool-activity";
import { childCallSummary } from "../../src/child-call-summary";
import { ToolCard } from "../../src/components/transcript-cards";
import type { ChatMessage, ToolCallContent } from "../../src/events";

const records = [
  { id: "script/?", name: "read", args: '{"path":"a.txt"}', status: "running" },
  {
    id: "script/?",
    name: "models.classify",
    args: "fixture/classifier",
    status: "running",
  },
];
const finishedCalls = [
  {
    ...records[0],
    id: "script/1",
    status: "error",
    durationMs: 1600,
    error: "Cannot read a.txt",
  },
  { ...records[1], id: "script/models.classify/1", status: "ok" },
];

it("keeps CodeMode call positions through native temporary id changes", () => {
  const live = codemodeCalls({ calls: records })!.calls;
  expect(live.map(({ key }) => key)).toEqual(["codemode:0", "codemode:1"]);
  expect(codemodeCalls({ calls: finishedCalls })?.calls).toMatchObject([
    { key: live[0]!.key, status: "error" },
    { key: live[1]!.key, status: "ok" },
  ]);
});

it("distinguishes omitted arguments from unfinished child calls", async () => {
  const result: ChatMessage = {
    role: "toolResult",
    toolName: "orchestrator",
    content: "Parent output",
    isError: false,
    __inspireCalls: {
      source: "nested",
      complete: false,
      calls: [
        {
          key: "parent/1",
          name: "read",
          status: "unfinished",
          argumentsOmitted: true,
        },
        { key: "parent/2", name: "write", status: "cancelled" },
      ],
    },
  };
  const parent: ToolCallContent = {
    type: "toolCall",
    id: "parent",
    name: "orchestrator",
    arguments: {},
  };
  const view = render(
    <ToolCard
      call={parent}
      result={result}
      activity={undefined}
      live={false}
      visibility="expanded"
    />,
  );
  for (const status of ["Unfinished", "Cancelled"])
    expect(screen.getByText(status)).toBeVisible();
  const row = view.container.querySelector(".child-call > summary")!;
  (row.parentElement as HTMLDetailsElement).open = true;
  fireEvent(row.parentElement!, new Event("toggle"));
  expect(await screen.findByText("Arguments not retained")).toBeInTheDocument();
  expect(screen.queryByText("Available arguments")).not.toBeInTheDocument();
  expect(screen.getByText(/Call record incomplete/)).toBeInTheDocument();
});

describe("childCallSummary", () => {
  const summaryCall = { key: "test", name: "edit", status: "ok" as const };
  const preview = (argumentsPreview: string) =>
    childCallSummary({ ...summaryCall, argumentsPreview });

  it("summarizes intact arguments and native model identities without changing path values", () => {
    expect(
      childCallSummary({
        ...summaryCall,
        arguments: { path: "src/app.tsx", edits: [] },
      }),
    ).toEqual({ text: "src/app.tsx", path: true });
    expect(
      preview('{"command":"npm run typecheck\\nnpm run build"}').text,
    ).toBe("npm run typecheck");
    expect(preview('{"drop":"1","quiet":true}').text).toBe(
      "drop: 1 · quiet: true",
    );
    expect(
      childCallSummary({
        ...summaryCall,
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
    expect(preview('{"path":"real.ts"')).toEqual({
      text: "real.ts",
      path: true,
    });
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
});
