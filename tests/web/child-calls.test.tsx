// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_CHILD_CALLS, resultChildCalls } from "../../shared/tool-activity";
import { ToolCard } from "../../src/components/transcript-cards";
import {
  emptyEventSlice,
  reduceEvent,
  type ActivityTool,
  type ChatMessage,
  type ToolCallContent,
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
const final: ChatMessage = {
  role: "toolResult",
  toolCallId: "script",
  toolName: "codemode",
  isError: false,
  content: [{ type: "text", text: "Script completed\nactual result" }],
  details: {
    calls: [
      {
        ...records[0],
        id: "script/1",
        status: "error",
        durationMs: 1600,
        error: "Cannot read a.txt",
      },
      { ...records[1], id: "script/models.classify/1", status: "ok" },
    ],
  },
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

it("keeps manually opened child detail, focus and list position through settlement; settled history defaults to result first", async () => {
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
  expect(screen.getByRole("button", { name: "Calls 2" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
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
  const list = screen.getByRole("group", { name: "Child calls" });
  list.scrollTop = 60;
  fireEvent.scroll(list);
  vi.useFakeTimers();
  view.rerender(
    toolCard(final, { ...activity, phase: "done" }, "expanded", true, hold),
  );
  act(() => vi.advanceTimersByTime(5_000));
  vi.useRealTimers();
  expect(hold).toHaveBeenCalledWith(true);
  expect(
    screen.getByRole("button", { name: "Collapse codemode tool" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(view.container.querySelector(".child-call > summary")).toBe(row);
  expect(document.activeElement).toBe(row);
  expect(list.scrollTop).toBe(60);
  expect(row.parentElement).toHaveAttribute("open");
  expect(
    await screen.findByRole("group", { name: "Call error" }),
  ).toHaveTextContent("Cannot read a.txt");
  expect(screen.getByText("Duration · 1.6 s")).toBeInTheDocument();
  expect(view.container.querySelector(".card--failed")).toBeNull();
  expect(
    view.container
      .querySelector(".tool-call-disclosure")!
      .compareDocumentPosition(
        view.container.querySelector(".tool-call-result")!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.unmount();
  render(toolCard(final));
  expect(screen.getByText(/actual result/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Calls 2" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.queryByRole("group", { name: "Child calls" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("JavaScript", { exact: true }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Calls 2" }));
  expect(
    document
      .querySelector(".tool-call-result")!
      .compareDocumentPosition(
        document.querySelector(".tool-call-disclosure")!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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
  fireEvent.click(
    screen.getByRole("button", { name: `Calls ${MAX_CHILD_CALLS}` }),
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
  fireEvent.click(screen.getByRole("button", { name: "Expand codemode tool" }));
  expect(
    view.container.querySelector('[data-tool-rule="inspire.pi.codemode"]'),
  ).toBeNull();
  expect(view.container.querySelector(".tool-call-script")).toBeNull();
  expect(
    await screen.findByRole("button", { name: "Calls 2" }),
  ).toHaveAttribute("aria-expanded", "false");
  spy.mockRestore();
});
