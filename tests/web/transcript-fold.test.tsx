// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import {
  type ActivityTelemetryItem,
  ResponseActivityFold,
} from "../../src/components/transcript-fold";

function transcript(
  messages: React.ComponentProps<typeof Transcript>["messages"],
  activityFoldVisibility: React.ComponentProps<
    typeof Transcript
  >["activityFoldVisibility"],
  extra: Partial<React.ComponentProps<typeof Transcript>> = {},
) {
  return (
    <Transcript
      messages={messages}
      streaming={false}
      thinkingVisibility="expanded"
      toolVisibility="collapsed"
      activityFoldVisibility={activityFoldVisibility}
      {...extra}
    />
  );
}

function toolCalls(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "toolCall",
    id: `round-${index}`,
    name: `tool-${index}`,
    arguments: { path: `file-${index}.ts` },
  }));
}

function toolRounds(count: number) {
  return toolCalls(count).map((call, index) => ({
    role: "assistant",
    timestamp: index + 1,
    content: [call],
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("response activity folds", () => {
  it("summarizes known hidden records separately from the visible tail and leaves deferred records empty", () => {
    const telemetry = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      kind: "tool" as const,
      live: index === 15,
    }));
    const view = (active: boolean, records: ActivityTelemetryItem[]) => (
      <ResponseActivityFold
        visibility="compact"
        closeRequested={false}
        lifecycleActive={active}
        telemetry={records}
      >
        Activity
      </ResponseActivityFold>
    );
    const { container, rerender } = render(
      view(true, [
        { id: "old-known", kind: "thinking" },
        { id: "opaque", kind: "tool", deferred: true },
        ...telemetry.slice(-24),
      ]),
    );
    const ids = (selector: string) =>
      [...container.querySelectorAll(selector)].map((cell) =>
        cell.getAttribute("data-activity-id"),
      );
    const omission = container.querySelector(".activity-fold__omission")!;
    expect(
      omission.querySelectorAll(".activity-fold__cell-empty"),
    ).toHaveLength(9);
    expect(omission).toHaveAttribute(
      "aria-description",
      "Expand to load earlier activity.",
    );
    const latest = ".activity-fold__boundary--upper .activity-fold__kind";
    const tail = telemetry.slice(-9).map(({ id }) => id);
    expect(ids(latest)).toEqual(tail);
    rerender(view(true, telemetry));
    expect(ids(latest)).toEqual(tail);
    expect(ids(".activity-fold__omission .activity-fold__kind")).toEqual(
      Array.from({ length: 9 }, (_, i) => String(7 + i)),
    );
    expect(
      container.querySelectorAll(
        ".activity-fold__omission .activity-fold__kind--live",
      ),
    ).toHaveLength(1);
    rerender(view(false, telemetry));
    expect(container.querySelector(".activity-fold__kind--live")).toBeNull();
  });

  it("summarizes repeated tools, deferred steps and failures in the fold header", () => {
    const { container } = render(
      <ResponseActivityFold
        visibility="expanded"
        lifecycleActive={false}
        closeRequested={false}
        telemetry={[
          { id: "1", kind: "thinking" },
          { id: "2", kind: "tool", name: "codemode" },
          { id: "3", kind: "tool", name: "codemode" },
          { id: "4", kind: "tool", name: "preview_check", failed: true },
          { id: "5", kind: "tool", name: "read" },
          { id: "6", kind: "tool", name: "edit" },
          { id: "7", kind: "tool", deferred: true },
        ]}
      >
        Activity
      </ResponseActivityFold>,
    );
    const summary = container.querySelector(".activity-fold__summary")!;
    expect(summary).toHaveTextContent(
      "7 steps · codemode ×2 · preview_check · read +1 · 1 failed",
    );
    expect(
      summary.querySelector(".activity-fold__summary-failed"),
    ).toHaveTextContent("1 failed");
  });

  it("applies the Compact limit to calls and unpaired results together", () => {
    const [first, ...rest] = toolCalls(25);
    const unpaired = {
      role: "toolResult",
      toolCallId: "unpaired",
      toolName: "unpaired",
      content: "unpaired result",
    };
    const messages = [
      { role: "assistant", content: [first!] },
      unpaired,
      { role: "assistant", content: rest },
    ];
    const { container, rerender } = render(
      transcript(
        [unpaired, { ...messages[2]!, content: rest.slice(0, 23) }],
        "compact",
        {
          toolVisibility: "compact",
        },
      ),
    );
    const earlier = { name: "Show all earlier assistant activity" };
    expect(
      screen.getByRole("button", { name: "Expand unpaired result details" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", earlier)).not.toBeInTheDocument();
    rerender(transcript(messages, "compact", { toolVisibility: "compact" }));
    expect(container.querySelectorAll(".card--tool")).toHaveLength(24);
    expect(
      screen.queryByRole("button", { name: "Expand unpaired result details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand tool-24 tool" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", earlier));
    expect(
      screen.getByRole("button", { name: "Expand tool-0 tool" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand unpaired result details" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", earlier)).not.toBeInTheDocument();
  });

  it("restores only deliberate card choices after compact omission", () => {
    const messages = toolRounds(26);
    const view = (
      density: "compact" | "expanded",
      tools: "compact" | "expanded",
    ) => transcript(messages, density, { toolVisibility: tools });
    const { rerender } = render(view("expanded", "compact"));
    fireEvent.click(screen.getByRole("button", { name: "Expand tool-0 tool" }));
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool" }),
    ).toBeVisible();
    rerender(view("compact", "expanded"));
    expect(
      screen.queryByRole("button", { name: "Collapse tool-0 tool" }),
    ).toBeNull();
    rerender(view("expanded", "expanded"));
    // Explicit tool-0 choice survives omission; untouched tool-1 follows its
    // new preference rather than a previously observed default.
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse tool-1 tool" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse tool-0 tool" }),
    );
    rerender(view("compact", "expanded"));
    rerender(view("expanded", "expanded"));
    expect(
      screen.getByRole("button", { name: "Expand tool-0 tool" }),
    ).toBeVisible();
  });

  it("restores a selected tool strip item without mounting its omitted detail", () => {
    const messages = [{ role: "assistant", content: toolCalls(26) }];
    const view = (density: "compact" | "expanded" | "collapsed") =>
      transcript(messages, density, { toolVisibility: "collapsed" });
    const { container, rerender } = render(view("expanded"));
    fireEvent.click(screen.getByRole("button", { name: /^tool-0: / }));
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool details" }),
    ).toBeVisible();
    rerender(view("compact"));
    expect(container.querySelector(".activity-strip__detail")).toBeNull();
    rerender(view("expanded"));
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool details" }),
    ).toBeVisible();
    rerender(view("collapsed"));
    expect(container.querySelector(".activity-strip")).toBeNull();
    rerender(view("expanded"));
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool details" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^tool-0: / }));
    rerender(view("collapsed"));
    rerender(view("expanded"));
    expect(container.querySelector(".activity-strip__detail")).toBeNull();
  });

  it("keeps focus in a compact group when a live append evicts the focused card", async () => {
    const messages = toolRounds(25);
    const view = (count: number) =>
      transcript(messages.slice(0, count), "compact", {
        streaming: true,
        toolVisibility: "compact",
      });
    const { rerender } = render(view(24));
    screen.getByRole("button", { name: "Expand tool-0 tool" }).focus();
    await act(async () => rerender(view(25)));
    expect(
      screen.getByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    ).toHaveFocus();
  });

  it.each(["strip button", "strip detail"])(
    "recovers focus when an append omits the focused %s within a retained strip",
    async (target) => {
      const calls = toolCalls(25);
      const view = (count: number) =>
        transcript(
          [{ role: "assistant", timestamp: 1, content: calls.slice(0, count) }],
          "compact",
          { toolVisibility: "collapsed" },
        );
      const { container, rerender } = render(view(24));
      const button = screen.getByRole("button", { name: /^tool-0: / });
      if (target === "strip detail") {
        fireEvent.click(button);
        screen.getByRole("group", { name: "Arguments" }).focus();
      } else button.focus();
      await act(async () => rerender(view(25)));
      expect(container.querySelectorAll(".activity-strip__item")).toHaveLength(
        24,
      );
      expect(container.querySelector(".activity-strip__detail")).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Show all earlier assistant activity",
        }),
      ).toHaveFocus();
    },
  );

  it("settles a live compact tool batch without waiting for its omitted cards", () => {
    vi.useFakeTimers();
    const message = {
      role: "assistant",
      timestamp: 1,
      __inspireLiveId: "compact-live",
      content: toolCalls(30),
    };
    const view = (running: boolean) =>
      transcript([message], "compact", {
        streaming: running,
        runState: running ? "running" : "idle",
        activeAssistantMessageKey: running ? "live:compact-live" : null,
        toolVisibility: "dynamic",
      });
    const { container, rerender } = render(view(true));
    expect(container.querySelectorAll(".card--tool")).toHaveLength(24);
    rerender(view(false));
    act(() => vi.advanceTimersByTime(1_500));
    act(() => vi.advanceTimersByTime(1_000));
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelectorAll(".activity-strip__item")).toHaveLength(
      24,
    );
    expect(container.querySelector(".card--tool")).toBeNull();
  });

  it("restores expanded result, arguments and output offsets after omitting a card", async () => {
    const output = `${"source line\n".repeat(80)}last output line`;
    const messages = [
      {
        role: "assistant",
        timestamp: 1,
        content: [
          {
            type: "toolCall",
            id: "reader",
            name: "mystery",
            arguments: { query: "retained arguments" },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: 2,
        toolCallId: "reader",
        toolName: "mystery",
        content: output,
      },
      ...toolRounds(24).map((round) => ({
        ...round,
        timestamp: round.timestamp + 2,
      })),
    ];
    const view = (density: "compact" | "expanded") =>
      transcript(messages, density, { toolVisibility: "expanded" });
    const { rerender } = render(view("expanded"));
    const card = screen
      .getByRole("button", { name: "Collapse mystery tool" })
      .closest(".card")!;
    fireEvent.click(
      within(card as HTMLElement).getByRole("button", { name: "Show all" }),
    );
    const argumentsDetails = card.querySelector("details")!;
    argumentsDetails.open = true;
    fireEvent(argumentsDetails, new Event("toggle"));
    await within(card as HTMLElement).findByRole("group", {
      name: "Arguments",
    });
    const reader = within(card as HTMLElement).getByRole("group", {
      name: "Result text",
    });
    fireEvent.scroll(reader, { target: { scrollTop: 80, scrollLeft: 17 } });
    rerender(view("compact"));
    expect(screen.queryByRole("group", { name: "Result text" })).toBeNull();
    rerender(view("expanded"));
    const restored = screen
      .getByRole("button", { name: "Collapse mystery tool" })
      .closest(".card")!;
    const restoredReader = within(restored as HTMLElement).getByRole("group", {
      name: "Result text",
    });
    expect(restoredReader).toHaveTextContent("last output line");
    expect(restoredReader.scrollTop).toBe(80);
    expect(restoredReader.scrollLeft).toBe(17);
    expect(restored.querySelector("details")).toHaveAttribute("open");
    expect(
      within(restored as HTMLElement).getByRole("group", { name: "Arguments" }),
    ).toHaveTextContent("retained arguments");
  });

  it("illuminates a newly filled matrix once, not each rolling update or history mount", () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `cell-${index}`,
      kind: "tool" as const,
    }));
    const fold = (start: number, end: number) => (
      <ResponseActivityFold
        visibility="collapsed"
        lifecycleActive={false}
        closeRequested={false}
        telemetry={items.slice(start, end)}
      >
        Content
      </ResponseActivityFold>
    );
    const { container, rerender, unmount } = render(fold(0, 8));
    const matrix = () => container.querySelector(".activity-fold__matrix");
    expect(matrix()).not.toHaveClass("activity-fold__matrix--full");
    rerender(fold(0, 9));
    expect(matrix()).toHaveClass(
      "activity-fold__matrix--full",
      "activity-fold__matrix--lighting",
    );
    act(() => vi.advanceTimersByTime(800));
    expect(matrix()).not.toHaveClass("activity-fold__matrix--lighting");
    rerender(fold(0, 10));
    expect(
      [...matrix()!.querySelectorAll(".activity-fold__kind")].map((cell) =>
        cell.getAttribute("data-activity-id"),
      ),
    ).toEqual(items.slice(-9).map(({ id }) => id));
    expect(matrix()).toHaveClass("activity-fold__matrix--full");
    expect(matrix()).not.toHaveClass("activity-fold__matrix--lighting");
    unmount();
    const history = render(fold(0, 9));
    expect(
      history.container.querySelector(".activity-fold__matrix"),
    ).not.toHaveClass("activity-fold__matrix--lighting");
  });

  it("settles each tool cell when its result arrives while the later call keeps pulsing", () => {
    const assistant = {
      role: "assistant",
      __inspireLiveId: "two-calls",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "toolCall", id: "read", name: "read", arguments: {} },
        { type: "toolCall", id: "bash", name: "bash", arguments: {} },
      ],
    };
    const result = (toolCallId: string) => ({
      role: "toolResult",
      toolCallId,
      toolName: toolCallId,
      content: "done",
    });
    const view = (finished: string[]) =>
      transcript([assistant, ...finished.map(result)], "collapsed", {
        runState: finished.length === 2 ? "idle" : "running",
        activeAssistantMessageKey:
          finished.length === 2 ? null : "live:two-calls",
      });
    const { container, rerender } = render(view([]));
    const cells = () => [...container.querySelectorAll(".activity-fold__kind")];
    const live = () =>
      cells().map((cell) =>
        cell.classList.contains("activity-fold__kind--live"),
      );
    expect(cells()).toHaveLength(3);
    expect(cells()[0]).toHaveClass("activity-fold__kind--thinking");
    expect(cells()[0]?.closest(".activity-fold__matrix")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(live()).toEqual([false, true, true]);
    rerender(view(["read"]));
    expect(live()).toEqual([false, false, true]);
    rerender(view(["read", "bash"]));
    expect(live()).toEqual([false, false, false]);
  });

  it("does not make group Expanded override individual Thinking and Tool preferences", () => {
    render(
      transcript(
        [
          {
            role: "assistant",
            timestamp: 1,
            content: [
              { type: "thinking", thinking: "Independent thought" },
              {
                type: "toolCall",
                id: "independent-tool",
                name: "bash",
                arguments: { command: "pwd" },
              },
            ],
          },
        ],
        "expanded",
        { thinkingVisibility: "collapsed", toolVisibility: "compact" },
      ),
    );
    expect(
      screen.getByRole("button", { name: "Expand Thinking" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand bash tool" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    { preference: "dynamic", running: false, initial: "closed" },
    { preference: "dynamic", running: true, initial: "compact" },
    { preference: "compact", running: false, initial: "compact" },
    { preference: "expanded", running: false, initial: "expanded" },
  ] as const)(
    "materializes deferred activity at the requested density ($preference, running $running)",
    async ({ preference, running, initial }) => {
      const onMaterialize = vi.fn(async () => undefined);
      const range = {
        cursor: "range-1",
        afterMessageId: "response-id",
        messageCount: 100,
        kinds: ["tool"] as ("thinking" | "tool")[],
        status: "idle" as const,
        error: null,
      };
      const response = {
        role: "assistant",
        content: "visible response",
        __inspireMessageId: "response-id",
      };
      const view = (failed: boolean) =>
        transcript([response], preference, {
          streaming: running,
          runState: running ? "running" : "idle",
          activityRanges: [
            failed
              ? {
                  ...range,
                  status: "error",
                  error: "range expired",
                }
              : range,
          ],
          onMaterializeActivityRanges: onMaterialize,
        });
      const { container, rerender } = render(view(false));
      const fold = container.querySelector(
        "[data-activity-fold]",
      ) as HTMLElement;
      const controls = within(fold);
      if (initial === "closed") {
        expect(onMaterialize).not.toHaveBeenCalled();
        expect(fold.querySelector(".activity-fold__kind")).toBeNull();
        expect(fold.querySelector(".activity-fold__matrix")).toHaveAttribute(
          "title",
          "Expand to load recent activity.",
        );
        fireEvent.click(
          controls.getByRole("button", { name: "Expand assistant activity" }),
        );
      }
      const firstScope = initial === "expanded" ? "all" : "tail";
      expect(fold).toHaveAttribute(
        "data-activity-fold-presentation",
        firstScope === "all" ? "expanded" : "compact",
      );
      expect(onMaterialize).toHaveBeenCalledExactlyOnceWith(
        ["range-1"],
        expect.any(Function),
        firstScope,
      );
      if (firstScope === "tail") {
        fireEvent.click(
          controls.getByRole("button", {
            name: "Show all earlier assistant activity",
          }),
        );
      } else {
        rerender(view(true));
        fireEvent.click(
          controls.getByRole("button", {
            name: "Retry loading all earlier assistant activity",
          }),
        );
      }
      await act(async () => undefined);
      expect(fold).toHaveAttribute(
        "data-activity-fold-presentation",
        "expanded",
      );
      expect(onMaterialize).toHaveBeenLastCalledWith(
        ["range-1"],
        expect.any(Function),
        "all",
      );
    },
  );

  it("retains the opened fold identity when a deferred range becomes real activity", async () => {
    const onMaterialize = vi.fn(async () => undefined);
    const response = {
      role: "assistant",
      content: "visible response",
      timestamp: 1,
      __inspireMessageId: "response-id",
    };
    const range = {
      cursor: "range-1",
      afterMessageId: "response-id",
      messageCount: 1,
      kinds: ["tool"] as ("thinking" | "tool")[],
      status: "idle" as const,
      error: null,
    };
    const { container, rerender } = render(
      transcript([response], "collapsed", {
        activityRanges: [range],
        onMaterializeActivityRanges: onMaterialize,
      }),
    );
    let fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Expand assistant activity",
      }),
    );
    await act(async () => undefined);
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    within(fold)
      .getByRole("button", {
        name: "Show all earlier assistant activity",
      })
      .focus();

    rerender(
      transcript(
        [
          response,
          {
            role: "toolResult",
            toolName: "read",
            content: "materialized result",
            timestamp: 2,
            __inspireMessageId: "activity-id",
            __inspireActivityRangeCursor: "range-1",
          },
        ],
        "collapsed",
        {
          activityRanges: [],
          onMaterializeActivityRanges: onMaterialize,
        },
      ),
    );
    fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    expect(
      within(fold).getByRole("button", { name: "Expand read result details" }),
    ).toBeVisible();
    await act(async () => Promise.resolve());
    expect(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    ).toHaveFocus();
  });

  it("resets fold-local choices when the projection incarnation changes", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "activity" },
          { type: "text", text: "response" },
        ],
      },
    ];
    const { container, rerender } = render(
      transcript(messages, "expanded", {
        sessionId: "session",
        viewId: "view",
        projectionIncarnation: "incarnation-a",
      }),
    );
    const original = container.querySelector(
      "[data-activity-fold]",
    ) as HTMLElement;
    fireEvent.click(
      within(original).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );
    expect(original).toHaveAttribute("data-activity-fold", "closed");

    rerender(
      transcript(messages, "expanded", {
        sessionId: "session",
        viewId: "view",
        projectionIncarnation: "incarnation-b",
      }),
    );
    const replaced = container.querySelector(
      "[data-activity-fold]",
    ) as HTMLElement;
    expect(replaced).toHaveAttribute("data-activity-fold", "open");
  });

  it("preserves custom, fold and result disclosures when an older page pairs a loaded result", () => {
    const results = ["read", "beta"].map((toolName, index) => ({
      role: "toolResult",
      toolName,
      toolCallId: `${toolName}-call`,
      content: `${toolName} result`,
      timestamp: index + 2,
      __inspireMessageId: `${toolName}-result`,
    }));
    const recent = [
      ...results,
      { role: "assistant", content: "visible response", timestamp: 4 },
      {
        role: "custom",
        customType: "relay",
        content: "recent message",
        details: { source: "peer" },
        __inspireEntryId: "custom-recent",
        timestamp: 5,
      },
    ];
    const older = [
      {
        role: "custom",
        customType: "relay",
        content: "earlier message",
        __inspireEntryId: "custom-earlier",
      },
      {
        role: "assistant",
        timestamp: 1,
        content: [
          {
            type: "toolCall",
            id: "read-call",
            name: "read",
            arguments: { path: "src/paged.ts" },
          },
        ],
      },
    ];
    const { rerender } = render(transcript(recent, "expanded"));
    const details = () =>
      screen
        .getByText("recent message")
        .closest("article")!
        .querySelector("details");
    fireEvent.click(within(details()!).getByText("Details"));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand beta result details" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );

    rerender(transcript([...older, ...recent], "expanded"));
    expect(screen.getByText("earlier message")).toBeVisible();
    expect(details()).toHaveAttribute("open");
    fireEvent.click(
      screen.getByRole("button", { name: "Expand assistant activity" }),
    );
    expect(
      screen.getByRole("button", { name: "Expand read tool" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse beta result details" }),
    ).toBeVisible();
  });

  it("keeps one activity group across message boundaries until a visible answer", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 10,
        content: [
          { type: "thinking", thinking: "opening thought" },
          { type: "text", text: "opening response" },
          { type: "toolCall", id: "a", name: "read", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "a", content: "a", timestamp: 11 },
      {
        role: "assistant",
        timestamp: 12,
        content: [
          { type: "thinking", thinking: "middle thought" },
          { type: "toolCall", id: "b", name: "bash", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "b", content: "b", timestamp: 13 },
      {
        role: "assistant",
        timestamp: 14,
        content: [
          { type: "thinking", thinking: "last thought" },
          { type: "text", text: "closing response" },
        ],
      },
    ];
    const { container } = render(transcript(messages, "collapsed"));

    const folds = container.querySelectorAll<HTMLElement>(
      "[data-activity-fold]",
    );
    expect(folds).toHaveLength(2);
    const opening = screen.getByText("opening response");
    expect(
      folds[0]!.compareDocumentPosition(opening) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      opening.compareDocumentPosition(folds[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(folds[1]).toHaveAttribute("data-activity-fold", "closed");
    const summary = within(folds[1]!).getByRole("button", {
      name: "Expand assistant activity",
    });
    expect(summary).toBeVisible();
    expect(summary.querySelectorAll(".activity-fold__kind")).toHaveLength(4);
    expect(opening).toBeVisible();
    expect(screen.getByText("closing response")).toBeVisible();

    fireEvent.click(
      within(folds[1]!).getByRole("button", {
        name: "Expand assistant activity",
      }),
    );
    expect(folds[1]!.querySelectorAll(".turn--assistant")).toHaveLength(3);
    expect(screen.getByText("middle thought")).toBeVisible();
    expect(screen.getByText("last thought")).toBeVisible();
  });

  it.each(["answer", "failure"] as const)(
    "closes dynamic activity after a visible %s boundary and honors reopening",
    (boundary) => {
      vi.useFakeTimers();
      const active = {
        role: "assistant",
        timestamp: 20,
        __inspireLiveId: "dynamic-fold",
        content: [{ type: "thinking", thinking: "live thought" }],
      };
      const running = {
        streaming: true,
        runState: "running" as const,
        activeAssistantMessageKey: "live:dynamic-fold",
      };
      const answer = {
        ...active,
        content: [
          ...active.content,
          { type: "text", text: "response has started" },
        ],
      };
      const failed = {
        ...active,
        __inspireLiveId: undefined,
        __inspireMessageId: "persisted-failed-fold",
        __inspireSettled: true,
      };
      const { container, rerender } = render(
        transcript([active], "dynamic", running),
      );
      const fold = container.querySelector<HTMLElement>(
        "[data-activity-fold]",
      )!;
      expect(fold).toHaveAttribute("data-activity-fold", "open");
      act(() => vi.advanceTimersByTime(2_400));
      rerender(
        boundary === "answer"
          ? transcript([answer], "dynamic", running)
          : transcript([failed], "dynamic", { runState: "failed" }),
      );
      act(() => vi.advanceTimersByTime(799));
      expect(fold).toHaveAttribute("data-activity-fold", "open");
      act(() => vi.advanceTimersByTime(1));
      expect(fold).toHaveAttribute("data-activity-fold", "closed");

      fireEvent.click(
        within(fold).getByRole("button", { name: "Expand assistant activity" }),
      );
      if (boundary === "answer")
        rerender(
          transcript([{ ...answer, __inspireSettled: true }], "dynamic", {
            runState: "idle",
          }),
        );
      act(() => vi.runAllTimers());
      expect(fold).toHaveAttribute("data-activity-fold", "open");
    },
  );
});

it("keeps a live custom message outside the preceding tool strip through settlement", () => {
  const tools = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "read",
        name: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "toolCall",
        id: "bash",
        name: "bash",
        arguments: { command: "npm test" },
      },
    ],
  };
  const results = ["read", "bash"].map((name) => ({
    role: "toolResult",
    toolCallId: name,
    toolName: name,
    content: "done",
  }));
  const view = (settled: boolean) =>
    transcript(
      [
        tools,
        ...results,
        {
          role: "custom",
          customType: "relay_message",
          content: "delivered",
          display: true,
          __inspireLiveId: "relay",
          __inspireSettled: settled,
        },
      ],
      "expanded",
    );
  const { container, rerender } = render(view(false));
  const expectIndependent = () => {
    const strips = container.querySelectorAll(".activity-strip");
    expect(strips).toHaveLength(1);
    expect(strips[0]!.querySelectorAll(".activity-strip__item")).toHaveLength(
      2,
    );
    const message = screen.getByText("delivered");
    expect(message).toBeVisible();
    expect(message.closest("[data-activity-fold]")).toBeNull();
    expect(
      strips[0]!.compareDocumentPosition(message) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  };
  expectIndependent();
  rerender(view(true));
  expectIndependent();
});
