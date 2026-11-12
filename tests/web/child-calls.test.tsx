// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codemodeCalls } from "../../shared/tool-activity";
import { childCallSummary } from "../../src/child-call-summary";
import {
  ToolCard,
  ToolResultCard,
} from "../../src/components/transcript-cards";
import {
  type ChatMessage,
  emptyEventSlice,
  reduceEvent,
  type ToolCallContent,
  toolResultText,
} from "../../src/events";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";

const call: ToolCallContent = {
  type: "toolCall",
  id: "script",
  name: "codemode",
  arguments: { code: "text(await tools.read({path: 'a.txt'}));" },
};
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
const final: ChatMessage = {
  role: "toolResult",
  toolCallId: "script",
  toolName: "codemode",
  isError: false,
  content: [{ type: "text", text: "Script completed\nactual result" }],
  details: { calls: finishedCalls },
  __inspireCalls: codemodeCalls({ calls: finishedCalls }),
};
afterEach(() => configureToolPresentationRegistry());

it("expands the child-call summary and copies the complete original tool block", async () => {
  const result = {
    ...final,
    content: [
      {
        type: "text",
        text: "Script completed\nWall time 3.5 seconds\nOutput:\n",
      },
      { type: "text", text: '{"output":"line one\\nline two"}' },
    ],
  };
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <ToolCard
      call={call}
      result={result}
      activity={undefined}
      live={false}
      visibility="collapsed"
    />,
  );
  expect(screen.getByText("1 failed · 2 calls")).toBeVisible();
  expect(screen.queryByRole("group", { name: "Child calls" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand CodeMode tool" }));
  expect(
    await screen.findByRole("group", { name: "Child calls" }),
  ).toBeVisible();
  expect(screen.getByLabelText("finished", { exact: true })).toBeVisible();
  expect(screen.getByText("3.5s")).toBeVisible();
  expect(screen.getByText("Output", { exact: true })).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy codemode tool block" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      [
        "codemode",
        "Arguments",
        JSON.stringify(call.arguments, null, 2),
        "Result",
        toolResultText(result),
        "Result details",
        JSON.stringify(result.details, null, 2),
      ].join("\n\n"),
    ),
  );
});

it("retains result-only imports and their copy without inventing a Script", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <ToolResultCard
      result={{
        ...final,
        details: {
          ...(final.details as object),
          fullOutputPath: "/tmp/recorded-output.txt",
        },
      }}
      visibility="expanded"
    />,
  );
  expect(
    screen.getByRole("button", { name: "View full output" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy codemode result" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
    content: final.content,
    details: {
      calls: finishedCalls,
      fullOutputPath: "/tmp/recorded-output.txt",
    },
  });
  expect(screen.queryByText("Script", { exact: true })).not.toBeInTheDocument();
  expect(
    screen.queryByText("Result details", { exact: true }),
  ).not.toBeInTheDocument();
});

it("uses Codemode's snapshot positions, not temporary ids or generic receipts, and keeps parent outcome independent", () => {
  let slice = emptyEventSlice();
  const event = (event: Record<string, unknown>) => {
    slice = reduceEvent(slice, new Set(), event as { type: string }).slice;
  };
  event({
    type: "tool_execution_start",
    toolCallId: "script",
    toolName: "codemode",
    args: call.arguments,
  });
  event({
    type: "tool_execution_update",
    toolCallId: "script",
    toolName: "codemode",
    childCalls: codemodeCalls({ calls: records }),
  });
  event({
    type: "tool_execution_start",
    toolCallId: "script/1",
    parentToolCallId: "script",
    toolName: "read",
    childCall: { key: "script/1", name: "read", status: "running" },
  });
  expect(Object.keys(slice.tools)).toEqual(["script"]);
  const liveCalls = slice.tools.script?.calls?.calls.map(({ key }) => key);
  expect(liveCalls).toHaveLength(2);
  expect(new Set(liveCalls).size).toBe(2);
  event({
    type: "tool_execution_end",
    toolCallId: "script",
    toolName: "codemode",
    isError: false,
    childCalls: final.__inspireCalls,
  });
  expect(slice.tools.script).toMatchObject({
    phase: "done",
    calls: {
      calls: [
        { key: liveCalls![0], status: "error" },
        { key: liveCalls![1], status: "ok" },
      ],
    },
  });
  event({
    type: "tool_execution_update",
    toolCallId: "script",
    toolName: "codemode",
    childCalls: codemodeCalls({ calls: records }),
  });
  expect(slice.tools.script?.phase).toBe("done");
  expect(slice.tools.script?.calls?.calls[0]?.status).toBe("error");
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

it("shows generic child calls when the selected Codemode mapping is missing", async () => {
  configureToolPresentationRegistry({
    version: 1,
    rules: {},
    mappings: { codemode: "user.missing" },
  });
  render(
    <ToolCard
      call={call}
      result={final}
      activity={undefined}
      live={false}
      visibility="collapsed"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand CodeMode tool" }));
  expect(
    await screen.findByRole("group", { name: "Child calls" }),
  ).toBeVisible();
  expect(screen.getByRole("group", { name: "Result text" })).toHaveTextContent(
    "Script completed actual result",
  );
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
