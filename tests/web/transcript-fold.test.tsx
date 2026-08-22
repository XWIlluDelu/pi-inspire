// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("response activity folds", () => {
  it("keeps the unchanged card state between two interactive rails", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "before the first response" },
          { type: "text", text: "first response" },
          {
            type: "toolCall",
            id: "fold-tool",
            name: "read",
            arguments: { path: "src/a.ts" },
          },
          { type: "text", text: "second response" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "fold-tool",
        content: "file body",
        timestamp: 2,
      },
    ];
    const { container } = render(transcript(messages, "expanded"));

    expect(screen.getByText("first response")).toBeVisible();
    expect(screen.getByText("second response")).toBeVisible();
    expect(container.querySelectorAll("[data-activity-fold]")).toHaveLength(2);

    const toolCard = screen
      .getByText("read", { selector: ".card__tool-name" })
      .closest(".card") as HTMLElement;
    const toolFold = toolCard.closest(".activity-fold") as HTMLElement;
    const toolDisclosure = toolCard.querySelector(
      ".card__disclosure",
    ) as HTMLButtonElement;
    fireEvent.click(toolDisclosure);
    expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(toolFold.querySelectorAll(".activity-fold__rail")).toHaveLength(2);

    const lowerRail = within(toolFold).getByRole("button", {
      name: "Collapse assistant activity from the lower boundary",
    });
    fireEvent.click(lowerRail);
    expect(toolFold).toHaveAttribute("data-activity-fold", "closed");
    expect(lowerRail).toHaveFocus();
    expect(toolFold.querySelector(".activity-fold__content")).toHaveAttribute(
      "hidden",
    );
    expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");

    expect(
      within(toolFold).getByRole("button", {
        name: "Expand assistant activity from the lower boundary",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(toolFold).getByRole("button", {
        name: "Expand assistant activity from the upper boundary",
      }),
    );
    expect(toolFold).toHaveAttribute("data-activity-fold", "open");
    expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the latest 24 cards in Compact and expands the omitted prefix", () => {
    const toolCalls = Array.from({ length: 26 }, (_, index) => ({
      type: "toolCall",
      id: `compact-tool-${index + 1}`,
      name: `tool-${index + 1}`,
      arguments: { index: index + 1 },
    }));
    const messages = [{ role: "assistant", timestamp: 1, content: toolCalls }];
    const { container, rerender } = render(
      transcript(messages, "expanded", { toolVisibility: "expanded" }),
    );
    const retainedDisclosure = container.querySelector(
      ".card__disclosure",
    ) as HTMLButtonElement;
    fireEvent.click(retainedDisclosure);
    expect(retainedDisclosure).toHaveAttribute("aria-expanded", "false");
    rerender(transcript(messages, "compact", { toolVisibility: "expanded" }));

    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    expect(
      within(fold).getByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    ).toBeVisible();
    const boundaries = Array.from(
      fold.querySelectorAll<HTMLElement>(
        ".assistant-doc > .activity-item-boundary",
      ),
    );
    expect(boundaries).toHaveLength(26);
    expect(boundaries.filter((boundary) => boundary.hidden)).toHaveLength(2);
    expect(boundaries.filter((boundary) => !boundary.hidden)).toHaveLength(24);
    expect(boundaries[0]).toHaveAttribute("hidden");
    expect(boundaries[1]).toHaveAttribute("hidden");
    expect(boundaries[2]).not.toHaveAttribute("hidden");

    const visibleDisclosure = boundaries[2]!.querySelector(
      ".card__disclosure",
    ) as HTMLButtonElement;
    visibleDisclosure.focus();
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");

    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    );
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "expanded");
    expect(
      within(fold).queryByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    ).toBeNull();
    expect(boundaries.every((boundary) => !boundary.hidden)).toBe(true);
    expect(retainedDisclosure).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Compact assistant activity from the upper boundary",
      }),
    );
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );
    expect(fold).toHaveAttribute(
      "data-activity-fold-presentation",
      "collapsed",
    );
  });

  it("omits the structural round leads owned by Compact's hidden prefix", () => {
    const { container } = render(
      transcript(
        Array.from({ length: 26 }, (_, index) => ({
          role: "assistant",
          model: "test-model",
          timestamp: index + 1,
          content: [
            {
              type: "toolCall",
              id: `round-tool-${index + 1}`,
              name: `tool-${index + 1}`,
              arguments: {},
            },
          ],
        })),
        "compact",
        {
          assistantRoundDisplay: "divider",
          toolVisibility: "expanded",
        },
      ),
    );

    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    const visiblyOwned = (selector: string) =>
      Array.from(fold.querySelectorAll<HTMLElement>(selector)).filter(
        (element) => element.closest("[hidden]") === null,
      );
    expect(visiblyOwned(".turn--assistant")).toHaveLength(24);
    expect(visiblyOwned(".turn__divider")).toHaveLength(24);
  });

  it("makes Compact identical to Expanded when at most 24 cards exist", () => {
    const { container } = render(
      transcript(
        [
          {
            role: "assistant",
            timestamp: 1,
            content: Array.from({ length: 24 }, (_, index) => ({
              type: "toolCall",
              id: `small-compact-tool-${index + 1}`,
              name: `tool-${index + 1}`,
              arguments: {},
            })),
          },
        ],
        "compact",
        { toolVisibility: "expanded" },
      ),
    );

    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    expect(fold.querySelector(".activity-fold__omission")).toBeNull();
    expect(
      Array.from(
        fold.querySelectorAll<HTMLElement>(".activity-item-boundary"),
      ).every((boundary) => !boundary.hidden),
    ).toBe(true);
  });

  it("projects activity kinds and pulses only the live edge on both rails", () => {
    const active = {
      role: "assistant",
      timestamp: 3,
      __inspireLiveId: "telemetry-run",
      content: [
        { type: "thinking", thinking: "planning" },
        {
          type: "toolCall",
          id: "telemetry-tool",
          name: "read",
          arguments: { path: "src/a.ts" },
        },
      ],
    };
    const { container, rerender } = render(
      transcript([active], "expanded", {
        runState: "running",
        activeAssistantMessageKey: "live:telemetry-run",
      }),
    );
    const rails = container.querySelectorAll(".activity-fold__rail");
    expect(rails).toHaveLength(2);
    for (const rail of rails) {
      const segments = rail.querySelectorAll(".activity-fold__segment");
      expect(segments).toHaveLength(2);
      expect(segments[0]).toHaveClass("activity-fold__segment--thinking");
      expect(segments[0]).not.toHaveClass("activity-fold__segment--live");
      expect(segments[1]).toHaveClass("activity-fold__segment--tool");
      expect(segments[1]).toHaveClass("activity-fold__segment--live");
    }

    rerender(
      transcript([{ ...active, __inspireSettled: true }], "expanded", {
        runState: "idle",
        activeAssistantMessageKey: null,
      }),
    );
    expect(
      container.querySelectorAll(".activity-fold__segment--live"),
    ).toHaveLength(0);
  });

  it("opens a collapsed lazy range through Compact before Expanded", async () => {
    const onMaterialize = vi.fn(async () => undefined);
    const messages = [
      {
        role: "assistant",
        content: "visible response",
        timestamp: 1,
        __inspireMessageId: "response-id",
      },
    ];
    const { container } = render(
      transcript(messages, "dynamic", {
        activityRanges: [
          {
            cursor: "range-1",
            afterMessageId: "response-id",
            messageCount: 12,
            kinds: ["tool"],
            status: "idle",
            error: null,
          },
        ],
        onMaterializeActivityRanges: onMaterialize,
      }),
    );
    expect(onMaterialize).not.toHaveBeenCalled();
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Expand assistant activity",
      }),
    );
    await act(async () => undefined);
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    expect(onMaterialize).toHaveBeenCalledWith(
      ["range-1"],
      expect.any(Function),
      "tail",
    );
    expect(
      within(fold).queryByText("Earlier activity is available on demand"),
    ).toBeNull();

    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    );
    await act(async () => undefined);
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "expanded");
    expect(onMaterialize).toHaveBeenLastCalledWith(
      ["range-1"],
      expect.any(Function),
      "all",
    );
  });

  it("auto-loads fixed Expanded ranges without an on-demand text card", async () => {
    const onMaterialize = vi.fn(async () => undefined);
    const range = {
      cursor: "expanded-range",
      afterMessageId: "response-id",
      messageCount: 40,
      kinds: ["tool"] as ("thinking" | "tool")[],
      status: "idle" as const,
      error: null,
    };
    const response = {
      role: "assistant",
      content: "visible response",
      timestamp: 1,
      __inspireMessageId: "response-id",
    };
    const { container, rerender } = render(
      transcript([response], "expanded", {
        activityRanges: [range],
        onMaterializeActivityRanges: onMaterialize,
      }),
    );
    await act(async () => undefined);
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(onMaterialize).toHaveBeenCalledWith(
      ["expanded-range"],
      expect.any(Function),
      "all",
    );
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "expanded");
    expect(fold).not.toHaveTextContent(
      "Earlier activity is available on demand",
    );

    rerender(
      transcript([response], "expanded", {
        activityRanges: [
          {
            ...range,
            status: "error",
            error: "range expired",
          },
        ],
        onMaterializeActivityRanges: onMaterialize,
      }),
    );
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Retry loading all earlier assistant activity",
      }),
    );
    expect(onMaterialize).toHaveBeenLastCalledWith(
      ["expanded-range"],
      expect.any(Function),
      "all",
    );
  });

  it("loads only a bounded deferred tail for Compact, then the rest on expansion", async () => {
    const onMaterialize = vi.fn(async () => undefined);
    const { container } = render(
      transcript(
        [
          {
            role: "assistant",
            content: "visible response",
            timestamp: 1,
            __inspireMessageId: "response-id",
          },
        ],
        "compact",
        {
          activityRanges: [
            {
              cursor: "range-1",
              afterMessageId: "response-id",
              messageCount: 100,
              kinds: ["tool"],
              status: "idle",
              error: null,
            },
          ],
          onMaterializeActivityRanges: onMaterialize,
        },
      ),
    );
    await act(async () => undefined);
    expect(onMaterialize).toHaveBeenCalledWith(
      ["range-1"],
      expect.any(Function),
      "tail",
    );

    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Show all earlier assistant activity",
      }),
    );
    await act(async () => undefined);
    expect(onMaterialize).toHaveBeenLastCalledWith(
      ["range-1"],
      expect.any(Function),
      "all",
    );
  });

  it("keeps a live Dynamic fold Compact and fetches only its bounded tail", async () => {
    const onMaterialize = vi.fn(async () => undefined);
    const { container } = render(
      transcript(
        [
          {
            role: "assistant",
            content: "visible response",
            timestamp: 1,
            __inspireMessageId: "response-id",
          },
        ],
        "dynamic",
        {
          streaming: true,
          runState: "running",
          activityRanges: [
            {
              cursor: "range-1",
              afterMessageId: "response-id",
              messageCount: 1,
              kinds: ["tool"],
              status: "idle",
              error: null,
            },
          ],
          onMaterializeActivityRanges: onMaterialize,
        },
      ),
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    await act(async () => undefined);
    expect(onMaterialize).toHaveBeenCalledWith(
      ["range-1"],
      expect.any(Function),
      "tail",
    );
    expect(within(fold).queryByRole("button", { name: "Load" })).toBeNull();
  });

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
      within(fold).getByRole("button", { name: "Expand Tool Result read" }),
    ).toBeVisible();
    await act(async () => Promise.resolve());
    expect(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    ).toHaveFocus();
  });

  it("retains a manually closed leading fold when an older page extends it", () => {
    const recent = [
      {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "thinking", thinking: "recent activity" }],
      },
      { role: "assistant", timestamp: 3, content: "visible response" },
    ];
    const { container, rerender } = render(transcript(recent, "expanded"));
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    const thinkingDisclosure = within(fold).getByRole("button", {
      name: "Collapse Thinking",
    });
    fireEvent.click(thinkingDisclosure);
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );

    rerender(
      transcript(
        [
          {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "thinking", thinking: "earlier activity" }],
          },
          ...recent,
        ],
        "expanded",
      ),
    );

    expect(container.querySelector("[data-activity-fold]")).toBe(fold);
    expect(fold).toHaveAttribute("data-activity-fold", "closed");
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Expand assistant activity from the lower boundary",
      }),
    );
    expect(within(fold).getByText("earlier activity")).toBeVisible();
    expect(thinkingDisclosure).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the lower boundary",
      }),
    );
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
    expect(replaced).not.toBe(original);
    expect(replaced).toHaveAttribute("data-activity-fold", "open");
  });

  it("retains inner custom-card state when an older page extends its batch", () => {
    const recentCustom = {
      role: "custom",
      customType: "intercom",
      content: { message: "recent" },
      __inspireEntryId: "custom-recent",
      timestamp: 2,
    };
    const response = {
      role: "assistant",
      content: "visible response",
      timestamp: 3,
    };
    const { container, rerender } = render(
      transcript([recentCustom, response], "expanded", {
        toolVisibility: "expanded",
      }),
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    const recentDisclosure = within(fold).getByRole("button", {
      name: "Collapse Intercom custom activity",
    });
    fireEvent.click(recentDisclosure);
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );

    rerender(
      transcript(
        [
          {
            role: "custom",
            customType: "intercom",
            content: { message: "earlier" },
            __inspireEntryId: "custom-earlier",
            timestamp: 1,
          },
          recentCustom,
          response,
        ],
        "expanded",
        { toolVisibility: "expanded" },
      ),
    );

    expect(container.querySelector("[data-activity-fold]")).toBe(fold);
    expect(fold).toHaveAttribute("data-activity-fold", "closed");
    fireEvent.click(
      within(fold).getByRole("button", { name: "Expand assistant activity" }),
    );
    expect(recentDisclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("retains fold identity when an older tool call adopts a loaded result", () => {
    const result = {
      role: "toolResult",
      toolCallId: "paged-tool",
      toolName: "read",
      content: "file body",
      timestamp: 2,
    };
    const response = {
      role: "assistant",
      content: "visible response",
      timestamp: 3,
    };
    const { container, rerender } = render(
      transcript([result, response], "expanded"),
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    fireEvent.click(
      within(fold).getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      }),
    );

    rerender(
      transcript(
        [
          {
            role: "assistant",
            timestamp: 1,
            content: [
              {
                type: "toolCall",
                id: "paged-tool",
                name: "read",
                arguments: { path: "src/paged.ts" },
              },
            ],
          },
          result,
          response,
        ],
        "expanded",
      ),
    );

    expect(container.querySelector("[data-activity-fold]")).toBe(fold);
    expect(fold).toHaveAttribute("data-activity-fold", "closed");
    fireEvent.click(
      within(fold).getByRole("button", { name: "Expand assistant activity" }),
    );
    expect(
      within(fold).getByText("read", { selector: ".card__tool-name" }),
    ).toBeVisible();
  });

  it("forms one fold from all activity across assistant-message boundaries", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 10,
        content: [
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
    expect(folds).toHaveLength(1);
    expect(folds[0]).toHaveAttribute("data-activity-fold", "closed");
    expect(within(folds[0]!).getByText("···")).toBeVisible();
    expect(screen.getByText("opening response")).toBeVisible();
    expect(screen.getByText("closing response")).toBeVisible();

    fireEvent.click(
      within(folds[0]!).getByRole("button", {
        name: "Expand assistant activity",
      }),
    );
    expect(folds[0]!.querySelectorAll(".turn--assistant")).toHaveLength(3);
    expect(screen.getByText("middle thought")).toBeVisible();
    expect(screen.getByText("last thought")).toBeVisible();
  });

  it("dynamically closes after the next response appears and honors manual reopening", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 20,
      __inspireLiveId: "dynamic-fold",
      content: [{ type: "thinking", thinking: "live thought" }],
    };
    const props = {
      streaming: true,
      runState: "running" as const,
      activeAssistantMessageKey: "live:dynamic-fold",
      thinkingVisibility: "expanded" as const,
      toolVisibility: "collapsed" as const,
      activityFoldVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript messages={[active]} {...props} />,
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    act(() => vi.advanceTimersByTime(2_400));

    rerender(
      <Transcript
        messages={[
          {
            ...active,
            content: [
              { type: "thinking", thinking: "live thought" },
              { type: "text", text: "response has started" },
            ],
          },
        ]}
        {...props}
      />,
    );
    act(() => vi.advanceTimersByTime(799));
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    act(() => vi.advanceTimersByTime(1));
    expect(fold).toHaveAttribute("data-activity-fold", "closed");

    fireEvent.click(
      within(fold).getByRole("button", { name: "Expand assistant activity" }),
    );
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    expect(fold).toHaveAttribute("data-activity-fold-presentation", "compact");
    rerender(
      <Transcript
        messages={[
          {
            ...active,
            __inspireSettled: true,
            content: [
              { type: "thinking", thinking: "live thought" },
              { type: "text", text: "response has started" },
            ],
          },
        ]}
        {...props}
        streaming={false}
        runState="idle"
        activeAssistantMessageKey={null}
      />,
    );
    act(() => vi.runAllTimers());
    expect(fold).toHaveAttribute("data-activity-fold", "open");
  });

  it("treats a live displayed custom message as activity that can still grow", () => {
    vi.useFakeTimers();
    const started = {
      role: "custom",
      customType: "intercom_message",
      content: "intercom is working",
      display: true,
      timestamp: 25,
      __inspireLiveId: "intercom-fold",
    };
    const { container, rerender } = render(
      transcript([started], "dynamic", { runState: "idle" }),
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    act(() => vi.advanceTimersByTime(2_400));

    rerender(
      transcript([{ ...started, __inspireSettled: true }], "dynamic", {
        runState: "idle",
      }),
    );
    act(() => vi.advanceTimersByTime(800));
    expect(fold).toHaveAttribute("data-activity-fold", "closed");
  });

  it("dynamically closes a tail fold when the authoritative run fails", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 30,
      __inspireLiveId: "failed-fold",
      content: [{ type: "thinking", thinking: "unfinished thought" }],
    };
    const { container, rerender } = render(
      transcript([active], "dynamic", {
        streaming: true,
        runState: "running",
        activeAssistantMessageKey: "live:failed-fold",
      }),
    );
    const fold = container.querySelector("[data-activity-fold]") as HTMLElement;
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    act(() => vi.advanceTimersByTime(2_400));

    rerender(
      transcript(
        [
          {
            ...active,
            __inspireLiveId: undefined,
            __inspireMessageId: "persisted-failed-fold",
            __inspireSettled: true,
          },
        ],
        "dynamic",
        {
          streaming: false,
          runState: "failed",
          activeAssistantMessageKey: null,
        },
      ),
    );
    expect(container.querySelector("[data-activity-fold]")).toBe(fold);
    act(() => vi.advanceTimersByTime(799));
    expect(fold).toHaveAttribute("data-activity-fold", "open");
    act(() => vi.advanceTimersByTime(1));
    expect(fold).toHaveAttribute("data-activity-fold", "closed");
  });
});
