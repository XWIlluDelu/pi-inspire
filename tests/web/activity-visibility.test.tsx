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
  it("holds fast Thinking and parallel tools for their own dwell before collapsing", () => {
    vi.useFakeTimers();
    const names = ["read", "bash", "edit"];
    const active = {
      role: "assistant",
      timestamp: 20,
      __inspireLiveId: "call-1",
      content: [
        { type: "thinking", thinking: "first thought" },
        { type: "thinking", thinking: "second thought" },
        ...names.map((name) => ({
          type: "toolCall",
          id: name,
          name,
          arguments: {},
        })),
      ],
    };
    const next = {
      role: "assistant",
      timestamp: 21,
      __inspireLiveId: "call-2",
      content: [{ type: "thinking", thinking: "next call" }],
    };
    const view = (finished: number, advanced = false) => (
      <Transcript
        messages={advanced ? [active, next] : [active]}
        streaming={advanced}
        activeAssistantMessageKey={advanced ? "live:call-2" : "live:call-1"}
        toolActivity={Object.fromEntries(
          names.map((name, index) => [
            name,
            {
              id: name,
              name,
              phase:
                index < finished
                  ? name === "edit"
                    ? "error"
                    : "done"
                  : "running",
            },
          ]),
        )}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />
    );
    const { container, rerender } = render(view(0));
    const thinking = screen.getAllByRole("button", {
      name: "Collapse Thinking",
    });
    expect(thinking).toHaveLength(2);
    const expanded = (headers: HTMLElement[], value: boolean) => {
      for (const header of headers)
        expect(header).toHaveAttribute("aria-expanded", String(value));
    };
    const tools = names.map(
      (name) =>
        screen
          .getByText(name, { selector: ".card__tool-name" })
          .closest(".card")!
          .querySelector<HTMLElement>(".card__disclosure")!,
    );
    const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
    expanded(tools, true);
    rerender(view(2));
    advance(749);
    expanded(tools, true);

    rerender(view(3, true));
    advance(750);
    expanded(tools, true);
    advance(1);
    expanded(tools, false);
    advance(299);
    expanded(thinking, true);
    advance(1);
    expanded(thinking, false);
    expect(screen.getByText("next call")).toBeVisible();
    advance(680);
    advance(180);
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
    expect(container.querySelectorAll(".card--tool")).toHaveLength(1);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("holds an inspected Dynamic batch through settlement and remount until the reader closes it", () => {
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
    act(() => vi.advanceTimersByTime(1_500));
    fireEvent.click(screen.getByRole("button", { name: "Expand read tool" }));
    const settled = (activityFoldVisibility: "collapsed" | "expanded") => (
      <Transcript {...props} activityFoldVisibility={activityFoldVisibility} />
    );
    const held = () =>
      screen.getByRole("button", { name: "Collapse read tool" });
    rerender(settled("expanded"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(held()).toBeVisible();
    rerender(settled("collapsed"));
    expect(
      screen.queryByRole("button", { name: "Collapse read tool" }),
    ).toBeNull();
    rerender(settled("expanded"));
    expect(
      screen.getByRole("button", { name: "Expand bash tool" }),
    ).toBeVisible();
    fireEvent.click(held());
    act(() => vi.advanceTimersByTime(0));
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
    const view = (thinkingVisibility: "collapsed" | "hidden") => (
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: text }],
          },
        ]}
        streaming={false}
        thinkingVisibility={thinkingVisibility}
        toolVisibility="collapsed"
      />
    );
    const { rerender } = render(view("collapsed"));
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

    rerender(view("hidden"));
    expect(
      screen.queryByRole("button", { name: /Thinking/i }),
    ).not.toBeInTheDocument();
  });
});
