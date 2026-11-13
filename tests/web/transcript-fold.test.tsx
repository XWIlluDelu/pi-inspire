// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import { ResponseActivityFold } from "../../src/components/transcript-fold";

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

describe("response activity folds", () => {
  it("summarizes repeated tools and failures in the fold header", () => {
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
          { id: "7", kind: "tool" },
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
    expect(summary).toHaveTextContent("4 steps");
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
      rerender(
        boundary === "answer"
          ? transcript([answer], "dynamic", running)
          : transcript([failed], "dynamic", { runState: "failed" }),
      );
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
      expect(fold).toHaveAttribute("data-activity-fold", "open");
    },
  );
});
