// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_CHILD_CALLS, resultChildCalls } from "../../shared/tool-activity";
import {
  ToolCard,
  ToolResultCard,
} from "../../src/components/transcript-cards";
import {
  type ActivityTool,
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
};
afterEach(() => {
  vi.useRealTimers();
  configureToolPresentationRegistry();
});

function toolCard(
  result?: ChatMessage,
  activity?: ActivityTool,
  visibility: "expanded" | "collapsed" = "expanded",
  adaptive = false,
  onManualOpenChange?: (open: boolean) => void,
) {
  return (
    <ToolCard
      call={call}
      result={result}
      activity={activity}
      live={!result}
      visibility={visibility}
      dynamic={adaptive}
      dynamicActive={adaptive ? !result : undefined}
      onManualOpenChange={onManualOpenChange}
    />
  );
}

it("separates Calls and Output and copies the complete tool block once from the header", async () => {
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
  const view = render(toolCard(result));
  expect(screen.getByText("3.5s")).toBeVisible();
  expect(screen.getAllByText("1 failed · 2 calls")).toHaveLength(1);
  expect(screen.queryByText("Calls", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText("Output", { exact: true })).toBeVisible();
  expect(
    screen.queryByText("Result details", { exact: true }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Raw" })).not.toBeInTheDocument();
  const copy = screen.getAllByRole("button", {
    name: "Copy codemode tool block",
  });
  expect(copy).toHaveLength(1);
  expect(view.container.querySelector(".card__header")!.contains(copy[0])).toBe(
    true,
  );
  fireEvent.click(copy[0]);
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
    partialResult: { content: [], details: { calls: records } },
  });
  event({
    type: "tool_execution_start",
    toolCallId: "script/1",
    parentToolCallId: "script",
    toolName: "read",
    args: { path: "do-not-join.txt" },
  });
  expect(Object.keys(slice.tools)).toEqual(["script"]);
  expect(slice.tools.script?.calls?.calls.map((call) => call.key)).toEqual([
    "codemode:0",
    "codemode:1",
  ]);
  event({
    type: "tool_execution_end",
    toolCallId: "script",
    toolName: "codemode",
    isError: false,
    result: final,
  });
  expect(slice.tools.script).toMatchObject({
    phase: "done",
    calls: {
      calls: [
        { key: "codemode:0", status: "error" },
        { key: "codemode:1", status: "ok" },
      ],
    },
  });
  event({
    type: "tool_execution_update",
    toolCallId: "script",
    toolName: "codemode",
    partialResult: { details: { calls: records } },
  });
  expect(slice.tools.script?.phase).toBe("done");
  expect(slice.tools.script?.calls?.calls[0]?.status).toBe("error");
});

it("keeps Calls before Result and preserves child detail and focus through settlement and history", async () => {
  const activity: ActivityTool = {
    id: "script",
    name: "codemode",
    phase: "running",
    calls: resultChildCalls({
      toolName: "codemode",
      details: { calls: records },
    }),
  };
  const hold = vi.fn();
  const view = render(toolCard(undefined, activity, "expanded", true, hold));
  expect(
    screen.queryByRole("button", { name: "Calls 2" }),
  ).not.toBeInTheDocument();
  expect(view.container.querySelectorAll(".child-call")).toHaveLength(2);
  expect(screen.queryByText("Running…")).not.toBeInTheDocument();
  expect(screen.queryByText("Arguments preview")).not.toBeInTheDocument();
  const row = view.container.querySelector(
    ".child-call > summary",
  ) as HTMLElement;
  row.focus();
  fireEvent.click(row);
  (row.parentElement as HTMLDetailsElement).open = true;
  fireEvent(row.parentElement!, new Event("toggle"));
  await screen.findByRole("group", { name: "Arguments preview" });
  vi.useFakeTimers();
  view.rerender(
    toolCard(final, { ...activity, phase: "done" }, "expanded", true, hold),
  );
  act(() => vi.advanceTimersByTime(5_000));
  vi.useRealTimers();
  expect(hold).toHaveBeenCalledWith(true);
  expect(
    screen.getByRole("button", { name: "Collapse CodeMode tool" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(view.container.querySelector(".child-call > summary")).toBe(row);
  expect(document.activeElement).toBe(row);
  expect(row.parentElement).toHaveAttribute("open");
  expect(
    await screen.findByRole("group", { name: "Call error" }),
  ).toHaveTextContent("Cannot read a.txt");
  expect(screen.getByText("Duration · 1.6 s")).toBeInTheDocument();
  expect(view.container.querySelector(".card--failed")).toBeNull();
  expect(
    view.container
      .querySelector(".tool-call-list")!
      .compareDocumentPosition(
        view.container.querySelector(".tool-call-result")!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.unmount();
  render(toolCard(final));
  expect(screen.getByText(/actual result/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Calls 2" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("group", { name: "Child calls" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("JavaScript", { exact: true }),
  ).not.toBeInTheDocument();
  expect(
    document
      .querySelector(".tool-call-list")!
      .compareDocumentPosition(document.querySelector(".tool-call-result")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("keeps the collapsed summary useful and shows every call when the parent opens, without another list disclosure", async () => {
  const result: ChatMessage = {
    ...final,
    details: {
      calls: [
        ...finishedCalls,
        {
          id: "script/3",
          name: "grep",
          args: '{"pattern":"TODO"}',
          status: "ok",
        },
        {
          id: "script/4",
          name: "read",
          args: '{"path":"b.txt"}',
          status: "ok",
        },
      ],
    },
  };
  const view = render(toolCard(result, undefined, "collapsed"));
  expect(screen.getByText("CodeMode")).toBeVisible();
  expect(screen.getByText("1 failed · 4 calls")).toBeVisible();
  expect(view.container.querySelector(".card--failed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand CodeMode tool" }));
  const list = await screen.findByRole("group", { name: "Child calls" });
  expect(list.querySelectorAll(".child-call")).toHaveLength(4);
  expect(
    screen.queryByRole("button", { name: /^Calls / }),
  ).not.toBeInTheDocument();
});

it("holds an inspected Script open through Adaptive completion", async () => {
  const activity: ActivityTool = {
    id: "script",
    name: "codemode",
    phase: "running",
  };
  const hold = vi.fn();
  const view = render(toolCard(undefined, activity, "expanded", true, hold));
  const summary = view.container.querySelector(
    ".tool-call-script summary",
  ) as HTMLElement;
  fireEvent.click(summary);
  (summary.parentElement as HTMLDetailsElement).open = true;
  fireEvent(summary.parentElement!, new Event("toggle"));
  const scriptReader = within(summary.parentElement!);
  const code = await scriptReader.findByRole("group", { name: "Code" });
  expect(
    scriptReader.queryByText("JavaScript", { exact: true }),
  ).not.toBeInTheDocument();
  summary.focus();
  vi.useFakeTimers();
  view.rerender(
    toolCard(final, { ...activity, phase: "done" }, "expanded", true, hold),
  );
  act(() => vi.advanceTimersByTime(5_000));
  expect(hold).toHaveBeenCalledWith(true);
  expect(scriptReader.getByRole("group", { name: "Code" })).toBe(code);
  expect(document.activeElement).toBe(summary);
  expect(summary.parentElement).toHaveAttribute("open");
});

it("bounds long lists and distinguishes native previews, omitted arguments and unfinished summaries", async () => {
  const list = resultChildCalls({
    toolName: "orchestrator",
    details: { nestedCalls: { calls: [] } },
    nestedCalls: {
      complete: false,
      calls: Array.from({ length: MAX_CHILD_CALLS + 20 }, (_, index) => ({
        id: `parent/${index}`,
        name: "read",
        status: index === 0 ? "unfinished" : "ok",
        ...(index === 0
          ? { argumentsBytes: 10000 }
          : { arguments: { path: `file-${index}.txt` } }),
      })),
    },
  })!;
  expect(list.calls).toHaveLength(MAX_CHILD_CALLS);
  const result: ChatMessage = {
    role: "toolResult",
    toolName: "orchestrator",
    content: "Parent output",
    isError: false,
    __inspireCalls: list,
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
  expect(view.container.querySelectorAll(".child-call")).toHaveLength(
    MAX_CHILD_CALLS,
  );
  expect(screen.getByText("Unfinished")).toBeInTheDocument();
  const row = view.container.querySelector(".child-call > summary")!;
  (row.parentElement as HTMLDetailsElement).open = true;
  fireEvent(row.parentElement!, new Event("toggle"));
  expect(await screen.findByText("Arguments not retained")).toBeInTheDocument();
  expect(screen.queryByText("Available arguments")).not.toBeInTheDocument();
  expect(screen.getByText(/Call record incomplete/)).toBeInTheDocument();
});

it("retains lazy bodies and exact user-mapping precedence over the Codemode rule", async () => {
  configureToolPresentationRegistry({
    version: 1,
    rules: {},
    mappings: { codemode: "user.missing" },
  });
  const spy = vi.spyOn(JSON, "stringify");
  const view = render(toolCard(final, undefined, "collapsed"));
  expect(spy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand CodeMode tool" }));
  expect(
    view.container.querySelector('[data-tool-rule="inspire.pi.codemode"]'),
  ).toBeNull();
  expect(view.container.querySelector(".tool-call-script")).toBeNull();
  expect(
    await screen.findByRole("group", { name: "Child calls" }),
  ).toBeVisible();
  spy.mockRestore();
});
