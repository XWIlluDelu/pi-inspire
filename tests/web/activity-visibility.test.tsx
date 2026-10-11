// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("transcript density preferences", () => {
  const assistant = {
    role: "assistant",
    model: "gpt-test",
    stopReason: "toolUse",
    timestamp: 2,
    content: [
      {
        type: "toolCall",
        id: "tool-a",
        name: "ffgrep",
        arguments: { query: "alpha" },
      },
      {
        type: "toolCall",
        id: "tool-b",
        name: "read",
        arguments: { path: "src/a.ts" },
      },
      { type: "text", text: "between tool runs" },
      {
        type: "toolCall",
        id: "tool-c",
        name: "bash",
        arguments: { command: "npm test" },
      },
    ],
  };
  it("replaces only the assistant attribution row with a divider", () => {
    const { container, rerender } = render(
      <Transcript
        messages={[assistant]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        assistantRoundDisplay="divider"
      />,
    );
    expect(container.querySelectorAll(".turn__divider")).toHaveLength(1);
    expect(screen.queryByText("Pi")).not.toBeInTheDocument();
    expect(screen.queryByText("gpt-test")).not.toBeInTheDocument();
    expect(screen.queryByText("toolUse")).not.toBeInTheDocument();

    rerender(
      <Transcript
        messages={[assistant]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        assistantRoundDisplay="details"
      />,
    );
    expect(container.querySelector(".turn__divider")).toBeNull();
    expect(screen.getByText("Pi")).toBeInTheDocument();
    expect(screen.getByText("gpt-test")).toBeInTheDocument();
    expect(screen.getByText("toolUse")).toBeInTheDocument();
  });

  it("keeps the assistant attribution with a response when leading activity is folded", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            model: "gpt-test",
            timestamp: 2,
            content: [
              { type: "thinking", thinking: "hidden reasoning" },
              { type: "text", text: "visible response" },
            ],
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        activityFoldVisibility="collapsed"
        assistantRoundDisplay="details"
      />,
    );

    expect(container.querySelector("[data-activity-fold]")).toHaveAttribute(
      "data-activity-fold",
      "closed",
    );
    expect(screen.getByText("Pi").closest("[data-activity-fold]")).toBeNull();
    expect(screen.getByText("gpt-test")).toBeVisible();
    expect(screen.getByText("visible response")).toBeVisible();
    expect(screen.queryByText("hidden reasoning")).toBeNull();
  });

  it("toggles thinking and tool cards from non-interactive header space", () => {
    render(
      <Transcript
        messages={[
          {
            role: "assistant",
            timestamp: 12,
            content: [
              { type: "thinking", thinking: "reasoning details" },
              {
                type: "toolCall",
                id: "header-tool",
                name: "read",
                arguments: { path: "src/header.ts" },
              },
              { type: "text", text: "answer" },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "header-tool",
            content: "file body",
            timestamp: 13,
          },
          {
            role: "custom",
            customType: "intercom_message",
            content: "custom details",
            display: true,
            timestamp: 14,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const cards = [
      screen
        .getByText("Thinking", { selector: ".card__label" })
        .closest(".card") as HTMLElement,
      screen
        .getByText("read", { selector: ".card__tool-name" })
        .closest(".card") as HTMLElement,
    ];
    for (const card of cards) {
      const disclosure = card.querySelector(
        ".card__disclosure",
      ) as HTMLButtonElement;
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(
        card.querySelector(".card__header-spacer") as HTMLElement,
      );
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(card.querySelector(".card__header") as HTMLElement);
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("holds fast Thinking for 1800 ms and parallel tools for 1500 ms before lifecycle collapse", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 20,
      __inspireLiveId: "call-1",
      content: [
        { type: "thinking", thinking: "first thought" },
        { type: "thinking", thinking: "second thought" },
        {
          type: "toolCall",
          id: "parallel-a",
          name: "read",
          arguments: { path: "a.ts" },
        },
        {
          type: "toolCall",
          id: "parallel-b",
          name: "bash",
          arguments: { command: "npm test" },
        },
        {
          type: "toolCall",
          id: "parallel-c",
          name: "edit",
          arguments: { path: "b.ts" },
        },
      ],
    };
    const running = {
      "parallel-a": {
        id: "parallel-a",
        name: "read",
        phase: "running" as const,
      },
      "parallel-b": {
        id: "parallel-b",
        name: "bash",
        phase: "running" as const,
      },
      "parallel-c": {
        id: "parallel-c",
        name: "edit",
        phase: "running" as const,
      },
    };
    const { container, rerender } = render(
      <Transcript
        messages={[active]}
        streaming={false}
        activeAssistantMessageKey="live:call-1"
        toolActivity={running}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );

    const thinkingHeaders = screen.getAllByRole("button", {
      name: /^(?:Expand|Collapse) Thinking$/,
    });
    const toolHeader = (name: string) =>
      screen
        .getByText(name, { selector: ".card__tool-name" })
        .closest(".card")
        ?.querySelector(".card__disclosure") as HTMLElement;
    for (const header of thinkingHeaders)
      expect(header).toHaveAttribute("aria-expanded", "true");
    for (const name of ["read", "bash", "edit"])
      expect(toolHeader(name)).toHaveAttribute("aria-expanded", "true");

    rerender(
      <Transcript
        messages={[active]}
        streaming={false}
        activeAssistantMessageKey="live:call-1"
        toolActivity={{
          ...running,
          "parallel-b": { id: "parallel-b", name: "bash", phase: "done" },
          "parallel-c": { id: "parallel-c", name: "edit", phase: "error" },
        }}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    act(() => vi.advanceTimersByTime(749));
    for (const name of ["read", "bash", "edit"])
      expect(toolHeader(name)).toHaveAttribute("aria-expanded", "true");

    const next = {
      role: "assistant",
      timestamp: 21,
      __inspireLiveId: "call-2",
      content: [{ type: "thinking", thinking: "next call" }],
    };
    rerender(
      <Transcript
        messages={[active, next]}
        streaming
        activeAssistantMessageKey="live:call-2"
        toolActivity={{
          ...running,
          "parallel-a": { id: "parallel-a", name: "read", phase: "done" },
          "parallel-b": { id: "parallel-b", name: "bash", phase: "done" },
          "parallel-c": { id: "parallel-c", name: "edit", phase: "error" },
        }}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    act(() => vi.advanceTimersByTime(750));
    for (const header of thinkingHeaders)
      expect(header).toHaveAttribute("aria-expanded", "true");
    for (const name of ["read", "bash", "edit"])
      expect(toolHeader(name)).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    for (const name of ["read", "bash", "edit"])
      expect(toolHeader(name)).toHaveAttribute("aria-expanded", "false");
    for (const header of thinkingHeaders)
      expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(299));
    for (const header of thinkingHeaders)
      expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    for (const header of thinkingHeaders)
      expect(header).toHaveAttribute("aria-expanded", "false");
    expect(
      screen
        .getByText("next call")
        .closest(".card")
        ?.querySelector(".card__disclosure"),
    ).toHaveAttribute("aria-expanded", "true");

    act(() => vi.advanceTimersByTime(679));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).not.toBeNull();
    expect(container.querySelector(".activity-strip")).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(container.querySelectorAll(".activity-strip__item")).toHaveLength(3);
  });

  it("keeps completed Thinking visible for its 600 ms close grace after a long call", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 29,
      __inspireLiveId: "long-thinking",
      content: [{ type: "thinking", thinking: "long reasoning" }],
    };
    const props = {
      messages: [active],
      streaming: false,
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
      activityFoldVisibility: "expanded" as const,
    };
    const { rerender } = render(
      <Transcript {...props} activeAssistantMessageKey="live:long-thinking" />,
    );
    const header = screen.getByRole("button", { name: "Collapse Thinking" });
    act(() => vi.advanceTimersByTime(1_800));

    rerender(<Transcript {...props} activeAssistantMessageKey={null} />);
    act(() => vi.advanceTimersByTime(599));
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a final singleton tool Collapsed after its perceptible Expanded dwell", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 30,
      __inspireLiveId: "last-call",
      content: [
        {
          type: "toolCall",
          id: "last-tool",
          name: "read",
          arguments: { path: "last.ts" },
        },
      ],
    };
    const result = {
      role: "toolResult",
      toolCallId: "last-tool",
      content: "done",
      timestamp: 31,
    };
    const { container, rerender } = render(
      <Transcript
        messages={[active]}
        streaming={false}
        activeAssistantMessageKey="live:last-call"
        toolActivity={{
          "last-tool": { id: "last-tool", name: "read", phase: "running" },
        }}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    const header = container.querySelector(".card--tool .card__disclosure");
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1_500));

    rerender(
      <Transcript
        messages={[active, result]}
        streaming={false}
        activeAssistantMessageKey={null}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    act(() => vi.advanceTimersByTime(499));
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".activity-strip")).toBeNull();

    act(() => vi.advanceTimersByTime(2_000));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).toBeNull();
    expect(container.querySelector(".activity-strip")).toBeNull();
    expect(container.querySelectorAll(".card--tool")).toHaveLength(1);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("pauses eligible Dynamic batch collapse while a completed tool is manually inspected", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 40,
      __inspireLiveId: "held-call",
      content: [
        {
          type: "toolCall",
          id: "held-tool",
          name: "read",
          arguments: { path: "held.ts" },
        },
        {
          type: "toolCall",
          id: "held-tool-2",
          name: "bash",
          arguments: { command: "check held.ts" },
        },
      ],
    };
    const props = {
      messages: [active],
      streaming: false,
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript
        {...props}
        activeAssistantMessageKey="live:held-call"
        toolActivity={{
          "held-tool": { id: "held-tool", name: "read", phase: "done" },
          "held-tool-2": {
            id: "held-tool-2",
            name: "bash",
            phase: "done",
          },
        }}
      />,
    );
    const header = container.querySelector(
      ".card--tool .card__disclosure",
    ) as HTMLButtonElement;
    act(() => vi.advanceTimersByTime(1_500));
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");

    rerender(<Transcript {...props} activeAssistantMessageKey={null} />);
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.querySelector(".activity-strip")).toBeNull();
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(header);
    act(() => vi.advanceTimersByTime(0));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).not.toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(container.querySelectorAll(".activity-strip__item")).toHaveLength(2);
  });

  it("switches Dynamic density immediately when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const pending = {
      role: "assistant",
      timestamp: 41,
      __inspireLiveId: "reduced-call",
      content: [
        {
          type: "toolCall",
          id: "reduced-tool",
          name: "bash",
          arguments: { command: "check" },
        },
      ],
    };
    const props = {
      messages: [pending],
      streaming: false,
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript
        {...props}
        activeAssistantMessageKey="live:reduced-call"
        toolActivity={{
          "reduced-tool": {
            id: "reduced-tool",
            name: "bash",
            phase: "running",
          },
        }}
      />,
    );
    const header = container.querySelector(".card--tool .card__disclosure");
    rerender(<Transcript {...props} activeAssistantMessageKey={null} />);

    act(() => vi.runOnlyPendingTimers());
    act(() => vi.runOnlyPendingTimers());
    act(() => vi.runOnlyPendingTimers());
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".activity-strip")).toBeNull();
    expect(container.querySelectorAll(".card--tool")).toHaveLength(1);
  });

  it("renders the collapsed thinking summary as inline Markdown and keeps full markdown expanded", async () => {
    const text = "First line with **strong** and $E = mc^2$\nSecond line";
    const { rerender } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "thinking", thinking: text }],
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const thinkingCard = document.querySelector(
      ".card--thinking",
    ) as HTMLElement;
    const collapsed = thinkingCard.querySelector(
      ".card__disclosure",
    ) as HTMLElement;
    const summary = thinkingCard.querySelector(
      ".card__summary--prose",
    ) as HTMLElement;
    expect((await within(summary).findByText("strong")).tagName).toBe("STRONG");
    expect(summary.querySelector(".katex")).not.toBeNull();
    expect(screen.queryByText("Second line")).not.toBeInTheDocument();

    fireEvent.click(collapsed);
    const expanded = screen.getByText(/Second line/, {
      selector: ".rich-text--thinking p",
    });
    expect(
      within(expanded.parentElement as HTMLElement).getByText("strong").tagName,
    ).toBe("STRONG");

    rerender(
      <Transcript
        messages={[
          {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "thinking", thinking: text }],
          },
        ]}
        streaming={false}
        thinkingVisibility="hidden"
        toolVisibility="collapsed"
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Thinking/i }),
    ).not.toBeInTheDocument();
  });
});
