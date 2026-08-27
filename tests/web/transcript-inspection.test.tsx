// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionDisplayDock } from "../../src/components/ExtensionDisplays";
import { Transcript } from "../../src/components/Transcript";
import { findLiteralMatches } from "../../src/components/transcript-search";
import { store } from "../../src/store";
import { pendingQueues } from "./pending-fixtures";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settled transcript search", () => {
  it("keeps the compact floating search and filters all, user, or model text", () => {
    render(
      <Transcript
        sessionId="scoped"
        messages={[
          { role: "user", content: "shared phrase from user", timestamp: 1 },
          {
            role: "assistant",
            content: "shared phrase from model",
            timestamp: 2,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const search = screen.getByRole("search", {
      name: "Search settled transcript",
    });
    const input = screen.getByRole("searchbox", {
      name: "Search conversation",
    });
    const log = screen.getByRole("log");
    expect(search.parentElement).toHaveClass("transcript-wrap");
    expect(search.nextElementSibling).toBe(log);
    expect(search).not.toHaveClass("transcript-search--active");

    fireEvent.change(input, { target: { value: "shared" } });
    expect(search).toHaveClass("transcript-search--active");
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "User" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "Model" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search conversation" }),
      { target: { value: "user" } },
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("No matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");

    fireEvent.change(input, { target: { value: "" } });
    expect(search).not.toHaveClass("transcript-search--active");
  });

  it("opens and closes mobile search explicitly without hiding an active query", async () => {
    const { container } = render(
      <Transcript
        sessionId="mobile-search"
        messages={[
          { role: "user", content: "find this prompt", timestamp: 1 },
          { role: "assistant", content: "settled answer", timestamp: 2 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open conversation search" }),
    );
    const input = screen.getByRole("searchbox", {
      name: "Search conversation",
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(container.querySelector(".transcript-wrap")).toHaveClass(
      "transcript-wrap--mobile-search",
    );
    expect(
      screen.getByRole("search", { name: "Search settled transcript" }),
    ).toHaveClass("transcript-search--mobile-open");

    fireEvent.change(input, { target: { value: "find" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    fireEvent.click(
      screen.getByRole("button", { name: "Close conversation search" }),
    );

    expect(input).toHaveValue("");
    expect(container.querySelector(".transcript-wrap")).toHaveClass(
      "transcript-wrap--mobile-idle",
    );
    expect(
      screen.getByRole("button", { name: "Open conversation search" }),
    ).toBeInTheDocument();
  });

  it("finds case-insensitive literal occurrences only in settled user and assistant text", () => {
    expect(findLiteralMatches("Alpha alpha alphabet", "ALPHA", 3)).toEqual([
      { rowIndex: 3, offset: 0 },
      { rowIndex: 3, offset: 6 },
      { rowIndex: 3, offset: 12 },
    ]);

    const messages = [
      { role: "user", content: "Alpha alpha", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "BETA beta" },
          { type: "thinking", thinking: "hidden needle" },
          {
            type: "toolCall",
            id: "tool-1",
            name: "search",
            arguments: { query: "needle" },
          },
        ],
      },
      {
        role: "assistant",
        timestamp: 3,
        content: [{ type: "text", text: "live beta" }],
        __inspireLiveId: "assistant-live",
      },
      {
        role: "user",
        content: "unsettled beta",
        timestamp: 4,
        __inspireLiveId: "user-live",
      },
    ];
    const { rerender } = render(
      <Transcript
        sessionId="s1"
        messages={messages}
        streaming
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: "Search conversation",
    });

    fireEvent.change(input, { target: { value: "beta" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 matches");
    fireEvent.click(
      screen.getByRole("button", { name: "Next transcript match" }),
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 2");
    fireEvent.click(
      screen.getByRole("button", { name: "Previous transcript match" }),
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 of 2");
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "needle" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("No matches");

    fireEvent.change(input, { target: { value: "beta" } });
    rerender(
      <Transcript
        sessionId="s1"
        messages={[
          { role: "user", content: "older beta", timestamp: 0 },
          ...messages.map((message) =>
            message.timestamp === 3
              ? { ...message, __inspireSettled: true }
              : message,
          ),
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("4 matches");

    rerender(
      <Transcript
        sessionId="s2"
        messages={[
          { role: "user", content: "beta in another session", timestamp: 10 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(
      screen.getByRole("searchbox", { name: "Search conversation" }),
    ).toHaveValue("");
  });
});

describe("transcript live follow", () => {
  it("omits settled empty retry artifacts but represents the active empty call", () => {
    const settled = [
      { role: "user", content: "question", timestamp: 1 },
      { role: "assistant", content: [], stopReason: "error", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "recovered answer" }],
        timestamp: 3,
      },
    ];
    const { container, rerender } = render(
      <Transcript
        messages={settled}
        streaming={false}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(2);
    expect(container.querySelectorAll(".turn--assistant")).toHaveLength(1);

    const settledRetry = {
      role: "assistant",
      content: [],
      stopReason: "error",
      timestamp: 4,
      __inspireLiveId: "settled-retry",
      __inspireSettled: true,
    };
    rerender(
      <Transcript
        messages={[...settled, settledRetry]}
        streaming
        activeAssistantMessageKey="live:settled-retry"
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(2);

    const activeRetry = {
      role: "assistant",
      content: [],
      timestamp: 5,
      __inspireLiveId: "retry-call",
    };
    rerender(
      <Transcript
        messages={[...settled, activeRetry]}
        streaming
        activeAssistantMessageKey="live:retry-call"
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(3);
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("follows thinking and tool growth until the user deliberately scrolls away", () => {
    vi.useFakeTimers();
    const observed = new Map<Element, ResizeObserverCallback>();
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.set(target, this.callback);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const active = {
      role: "assistant",
      timestamp: 2,
      __inspireLiveId: "growing-call",
      content: [] as Array<Record<string, unknown>>,
    };
    const props = {
      streaming: true,
      activeAssistantMessageKey: "live:growing-call",
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript
        messages={[{ role: "user", content: "question", timestamp: 1 }, active]}
        {...props}
      />,
    );
    const log = screen.getByRole("log");
    expect(
      screen.getByText("Working…").closest(".assistant-activity"),
    ).toHaveAttribute("role", "status");
    let scrollHeight = 1_000;
    Object.defineProperties(log, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 700 },
    });

    rerender(
      <Transcript
        messages={[
          { role: "user", content: "question", timestamp: 1 },
          {
            ...active,
            content: [
              { type: "thinking", thinking: "live reasoning" },
              {
                type: "toolCall",
                id: "live-tool",
                name: "read",
                arguments: { path: "notes.md" },
              },
            ],
          },
        ]}
        {...props}
      />,
    );
    expect(log.scrollTop).toBe(700);
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    expect(container.querySelector(".card--thinking")).not.toBeNull();
    expect(container.querySelector(".card--tool")).not.toBeNull();

    // A delayed Markdown/card/virtual-row measurement must not turn the
    // programmatic follow scroll into apparent user intent.
    scrollHeight = 1_400;
    fireEvent.scroll(log);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    const content = container.querySelector(".transcript__content")!;
    act(() => observed.get(content)?.([], {} as ResizeObserver));
    expect(log.scrollTop).toBe(1_100);
    fireEvent.scroll(log);

    // Input precedes its scroll event. A stream delta in that gap must not win
    // the race and pull the viewport back to latest.
    fireEvent.wheel(log, { deltaY: -200 });
    scrollHeight = 1_450;
    rerender(
      <Transcript
        messages={[
          { role: "user", content: "question", timestamp: 1 },
          {
            ...active,
            content: [
              { type: "thinking", thinking: "live reasoning continues" },
              {
                type: "toolCall",
                id: "live-tool",
                name: "read",
                arguments: { path: "notes.md" },
              },
            ],
          },
        ]}
        {...props}
      />,
    );
    expect(log.scrollTop).toBe(1_100);

    // Even a small deliberate move inside the old 80px proximity band owns the
    // viewport. Later layout-driven scroll events must not silently reacquire
    // latest-follow after the input marker expires.
    log.scrollTop = 1_090;
    fireEvent.scroll(log);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(401));
    log.scrollTop = 1_120;
    fireEvent.scroll(log);
    scrollHeight = 1_700;
    act(() => observed.get(content)?.([], {} as ResizeObserver));
    expect(log.scrollTop).toBe(1_120);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });
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
  const results = [
    {
      role: "toolResult",
      toolCallId: "tool-a",
      toolName: "ffgrep",
      content: "alpha result",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "tool-b",
      toolName: "read",
      content: "read result",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "tool-c",
      toolName: "bash",
      content: "failed result",
      isError: true,
      timestamp: 5,
    },
  ];

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

  it("collapses only multi-activity runs and leaves a singleton Compact card", async () => {
    const { container } = render(
      <Transcript
        messages={[assistant, ...results]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        assistantRoundDisplay="divider"
      />,
    );
    const strips = container.querySelectorAll(".activity-strip");
    expect(strips).toHaveLength(1);
    expect(strips[0]!.querySelectorAll(".activity-strip__item")).toHaveLength(
      2,
    );
    const singleton = screen
      .getByText("bash", { selector: ".card__tool-name" })
      .closest(".card");
    expect(singleton?.querySelector(".card__disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const read = screen.getByRole("button", { name: /read: finished/i });
    fireEvent.click(read);
    expect(read).toHaveAttribute("aria-expanded", "true");
    const detail = strips[0]!.querySelector(".activity-strip__detail");
    expect(detail).not.toBeNull();
    expect(
      strips[0]!.querySelector(".activity-strip__items")?.nextElementSibling,
    ).toContainElement(detail as HTMLElement);
    expect(
      within(detail as HTMLElement).getByText("read result"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(detail as HTMLElement).getByRole("button", {
        name: "Collapse read tool details",
      }),
    );
    expect(read).toHaveAttribute("aria-expanded", "false");
    await waitFor(() =>
      expect(screen.queryByText("read result")).not.toBeInTheDocument(),
    );

    const ffgrep = screen.getByRole("button", { name: /ffgrep: finished/i });
    fireEvent.click(ffgrep);
    expect(container.querySelectorAll(".activity-strip__detail")).toHaveLength(
      1,
    );
    expect(screen.queryByText("read result")).not.toBeInTheDocument();
    expect(screen.getByText("alpha result")).toBeInTheDocument();

    fireEvent.click(ffgrep);
    expect(strips[0]!.querySelector(".activity-strip__reveal")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByText("alpha result")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("alpha result")).not.toBeInTheDocument(),
    );
  });

  it("keeps Compact activity as individually visible cards with closed bodies", () => {
    const { container } = render(
      <Transcript
        messages={[assistant, ...results]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="compact"
        assistantRoundDisplay="divider"
      />,
    );

    expect(container.querySelector(".activity-strip")).toBeNull();
    const cards = container.querySelectorAll(".card--tool");
    expect(cards).toHaveLength(3);
    for (const card of cards)
      expect(card.querySelector(".card__disclosure")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
  });

  it("loads historical Dynamic content directly at its final density", () => {
    const historical = {
      role: "assistant",
      timestamp: 10,
      content: [
        { type: "thinking", thinking: "settled reasoning\nmore detail" },
        {
          type: "toolCall",
          id: "history-a",
          name: "read",
          arguments: { path: "a.ts" },
        },
        {
          type: "toolCall",
          id: "history-b",
          name: "bash",
          arguments: { command: "npm test" },
        },
      ],
    };
    const { container } = render(
      <Transcript
        messages={[
          historical,
          {
            role: "toolResult",
            toolCallId: "history-a",
            content: "read",
            timestamp: 11,
          },
          {
            role: "toolResult",
            toolCallId: "history-b",
            content: "tested",
            timestamp: 12,
          },
        ]}
        streaming={false}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Expand Thinking" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll(".card--tool")).toHaveLength(0);
    expect(container.querySelectorAll(".activity-strip__item")).toHaveLength(2);
  });

  it("toggles thinking, tool, and custom cards from non-interactive header space", () => {
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
      screen
        .getByText("Intercom message", { selector: ".card__tool-name" })
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

  it("renders the collapsed thinking summary as inline Markdown and keeps full markdown expanded", () => {
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
    expect(within(summary).getByText("strong").tagName).toBe("STRONG");
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

describe("persisted user images", () => {
  it("loads a stable embedded-image reference and opens a keyboard-accessible preview", async () => {
    const originalLoad = store.loadEmbeddedImage;
    const load = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    store.loadEmbeddedImage = load;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:persisted-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    try {
      render(
        <Transcript
          sessionId="s-images"
          viewId="view-images"
          messages={[
            {
              role: "user",
              content: [
                { type: "image", mimeType: "image/png" },
                { type: "text", text: "caption" },
              ],
              timestamp: 1,
              __inspireMessageIndex: 4,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );
      const thumbnail = await screen.findByRole("button", {
        name: "Preview attached image",
      });
      expect(load).toHaveBeenCalledWith(
        "s-images",
        "view-images",
        "view-images\u0000",
        "pi-embedded://4/0",
        expect.any(AbortSignal),
      );
      expect(screen.getByText("caption")).toBeInTheDocument();
      const thumbnailImage = within(thumbnail).getByRole("img", {
        name: "Attached image",
      });
      expect(thumbnailImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(thumbnailImage)).toBe(false);

      fireEvent.click(thumbnail);
      const preview = screen.getByRole("dialog", { name: "Image preview" });
      const previewImage = within(preview).getByRole("img", {
        name: "Attached image",
      });
      expect(previewImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(previewImage)).toBe(false);

      const zoom = within(preview).getByRole("button", { name: "Zoom image" });
      fireEvent.click(zoom);
      expect(
        within(preview).getByRole("button", { name: "Fit image to window" }),
      ).toHaveAttribute("aria-pressed", "true");

      fireEvent.pointerDown(zoom, {
        pointerId: 1,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      fireEvent.pointerMove(zoom, { pointerId: 1, clientX: 20, clientY: 10 });
      expect(zoom).toHaveClass("image-lightbox__canvas--panning");
      fireEvent.pointerUp(zoom, { pointerId: 1, clientX: 20, clientY: 10 });
      fireEvent.click(zoom);
      expect(zoom).toHaveAttribute("aria-pressed", "true");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Image preview" }),
        ).not.toBeInTheDocument(),
      );
    } finally {
      store.loadEmbeddedImage = originalLoad;
    }
  });
});

describe("message actions", () => {
  it("copies each conversation message and forks through its authoritative entry id", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const originalFork = store.forkFromEntry;
    const fork = vi.fn(async () => true);
    store.forkFromEntry = fork;
    try {
      render(
        <Transcript
          sessionId="s1"
          messages={[
            {
              role: "user",
              content: "**user source**",
              timestamp: 1,
              __inspireEntryId: "entry-user",
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "assistant source" }],
              timestamp: 2,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );

      const userTurn = screen
        .getByText("user source")
        .closest(".turn") as HTMLElement;
      fireEvent.click(
        within(userTurn).getByRole("button", { name: "Copy message" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("**user source**"),
      );
      expect(
        within(userTurn).getByRole("button", { name: "Message copied" }),
      ).toBeInTheDocument();

      fireEvent.click(
        within(userTurn).getByRole("button", {
          name: "Fork session from this input",
        }),
      );
      await waitFor(() => expect(fork).toHaveBeenCalledWith("entry-user"));

      const assistantTurn = screen
        .getByText("assistant source")
        .closest(".turn") as HTMLElement;
      const responseActions = assistantTurn.querySelector(
        ".turn__actions--response",
      ) as HTMLElement;
      expect(
        assistantTurn.querySelector(".assistant-doc")?.nextElementSibling,
      ).toBe(responseActions);
      fireEvent.click(
        within(responseActions).getByRole("button", { name: "Copy response" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith("assistant source"),
      );
      expect(
        within(assistantTurn).queryByRole("button", { name: /Fork session/ }),
      ).not.toBeInTheDocument();
    } finally {
      store.forkFromEntry = originalFork;
    }
  });

  it("keeps response and activity-block clipboard projections separate", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const originalOpenResource = store.openResource;
    const openResource = vi.fn(async () => undefined);
    store.openResource = openResource;
    const generic = {
      type: "custom",
      extensionName: "Web search",
      payload: { count: 2 },
    };
    try {
      render(
        <Transcript
          messages={[
            {
              role: "assistant",
              timestamp: 1,
              content: [
                { type: "thinking", thinking: "private reasoning" },
                { type: "text", text: "first response" },
                {
                  type: "toolCall",
                  id: "copy-tool",
                  name: "read",
                  arguments: { path: "src/a.ts" },
                },
                { type: "text", text: "second response" },
                generic,
              ],
            },
            {
              role: "toolResult",
              toolCallId: "copy-tool",
              content: "file body",
              timestamp: 2,
            },
            {
              role: "custom",
              customType: "intercom_message",
              content: "custom payload",
              details: { channel: "local" },
              display: true,
              timestamp: 3,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
          assistantRoundDisplay="divider"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          "first response\n\nsecond response",
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy thinking block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith("private reasoning"),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy read tool block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          [
            "read",
            "Arguments",
            JSON.stringify({ path: "src/a.ts" }, null, 2),
            "Result",
            "file body",
          ].join("\n\n"),
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy web search block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          JSON.stringify(generic, null, 2),
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy intercom message block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          [
            "Intercom message",
            "Type: intercom_message",
            "Content",
            "custom payload",
            "Details",
            JSON.stringify({ channel: "local" }, null, 2),
          ].join("\n\n"),
        ),
      );

      const toolCard = screen
        .getByText("read", { selector: ".card__tool-name" })
        .closest(".card") as HTMLElement;
      const disclosure = within(toolCard).getByRole("button", {
        name: "Expand read tool",
      });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(
        within(toolCard).getByRole("button", { name: "src/a.ts" }),
      );
      await waitFor(() => expect(openResource).toHaveBeenCalledTimes(1));
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(
        toolCard.querySelector(".card__header-spacer") as HTMLElement,
      );
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(openResource).toHaveBeenCalledTimes(1);
      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(openResource).toHaveBeenCalledTimes(1);
    } finally {
      store.openResource = originalOpenResource;
    }
  });
});

describe("transient conversation projections", () => {
  it("distinguishes, numbers, and copies multiple ordered pending inputs", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Transcript
        messages={[{ role: "user", content: "persisted", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={pendingQueues(
          ["steer first", "steer second"],
          ["follow first", "follow second\ncontinued"],
        )}
      />,
    );
    const pending = screen.getByRole("region", { name: "Pending input" });
    const steering = screen.getByRole("region", { name: "Pending steer" });
    const followUp = screen.getByRole("region", { name: "Pending queue" });
    expect(
      within(steering)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("pre")?.textContent),
    ).toEqual(["steer first", "steer second"]);
    expect(
      within(followUp)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("pre")?.textContent),
    ).toEqual(["follow first", "follow second\ncontinued"]);
    expect(within(steering).getAllByText("S")).toHaveLength(2);
    expect(within(followUp).getAllByText("Q")).toHaveLength(2);

    fireEvent.click(
      within(steering).getByRole("button", { name: "Copy steer item 1" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("steer first"),
    );

    fireEvent.click(
      within(pending).getByRole("button", { name: "Copy all pending input" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        "1. steer first\n2. steer second\n3. follow first\n4. follow second\n   continued",
      ),
    );
    expect(
      screen.queryByRole("button", { name: /cancel/i }),
    ).not.toBeInTheDocument();
  });

  it("pauses active Pending and exposes lightweight management only while paused", async () => {
    const onManage = vi.fn(async () => true);
    const onReadTexts = vi.fn(async () => ["full steer", "full queue"]);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const queue = pendingQueues(["steer preview"], ["queue preview"], {
      managementAvailable: true,
      paused: true,
      revision: 7,
    });
    queue.steering[0]!.imageCount = 1;
    queue.steering[0]!.nonTextContentCount = 1;

    render(
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={queue}
        onManagePending={onManage}
        onPendingMessageTexts={onReadTexts}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Pending input paused" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pending paused")).toBeInTheDocument();
    expect(
      screen.getByText("1", { selector: ".pending-group__content-kind" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Move Steer item 1 to Queue" }),
    );
    expect(onManage).toHaveBeenLastCalledWith({
      action: "convert",
      messageId: queue.steering[0]!.id,
      target: "followUp",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Queue item 1" }),
    );
    expect(onManage).toHaveBeenLastCalledWith({
      action: "delete",
      messageId: queue.followUp[0]!.id,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Clear all Pending input" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onManage).toHaveBeenLastCalledWith({ action: "clear" });

    fireEvent.click(
      screen.getByRole("button", { name: "Copy all pending input" }),
    );
    await waitFor(() =>
      expect(onReadTexts).toHaveBeenLastCalledWith([
        queue.steering[0]!.id,
        queue.followUp[0]!.id,
      ]),
    );
    expect(writeText).toHaveBeenLastCalledWith("1. full steer\n2. full queue");
  });

  it("keeps an empty paused Pending panel until explicit resume", () => {
    const onManage = vi.fn(async () => true);
    render(
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={pendingQueues([], [], {
          managementAvailable: true,
          paused: true,
          revision: 3,
        })}
        onManagePending={onManage}
      />,
    );

    expect(screen.getByText("Pending paused")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Resume Pending input" }),
    );
    expect(onManage).toHaveBeenCalledWith({ action: "resume" });
    expect(
      screen.queryByRole("button", { name: "Clear all Pending input" }),
    ).not.toBeInTheDocument();
  });

  it("offers an independent pause action for active managed Pending", () => {
    const onManage = vi.fn(async () => true);
    render(
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={pendingQueues(["active"], [], {
          managementAvailable: true,
          revision: 1,
        })}
        onManagePending={onManage}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Pause Pending input" }),
    );
    expect(onManage).toHaveBeenCalledWith({ action: "pause" });
    expect(
      screen.queryByRole("button", { name: /Delete Steer/ }),
    ).not.toBeInTheDocument();
  });

  it("renders attributable extension content and hides anonymous extension plumbing", () => {
    const { rerender, container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [
              {
                type: "custom",
                title: "Extension content",
                extensionName: "Web search",
                payload: { hidden: true },
              },
            ],
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.getByText("Web search")).toHaveClass("card__generic-title");
    expect(screen.queryByText("Extension content")).not.toBeInTheDocument();
    expect(screen.queryByText("custom")).not.toBeInTheDocument();

    rerender(
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [
              null,
              "internal",
              7,
              { title: "Extension content" },
              { type: "CUSTOM" },
            ],
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.queryByText("Extension")).not.toBeInTheDocument();
    expect(container.querySelector(".card--generic")).toBeNull();
  });

  it("renders visible custom messages as aligned, inspectable activity and omits display:false", () => {
    const { rerender, container } = render(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "magic-context:ceiling-nudge",
            content: "context-only",
            display: false,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.queryByText(/Magic Context/)).not.toBeInTheDocument();
    expect(screen.queryByText("context-only")).not.toBeInTheDocument();
    expect(container.querySelector(".turn--custom")).toBeNull();

    rerender(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "intercom_message",
            content: "visible extension message",
            display: true,
            timestamp: 10,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const title = screen.getByText("Intercom message");
    expect(title).toHaveClass("card__tool-name");
    const card = title.closest(".card") as HTMLElement;
    expect(card).toHaveClass("card--custom");
    expect(card.querySelector(".card__icon svg")).toHaveAttribute(
      "width",
      "14",
    );
    const header = card.querySelector(".card__disclosure") as HTMLButtonElement;
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(card.querySelector(".card__status")).toBeEmptyDOMElement();
    fireEvent.click(header);
    expect(screen.getByText(/visible extension message/)).toBeInTheDocument();

    rerender(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "intercom_message",
            content: "visible extension message",
            display: true,
            timestamp: 10,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="hidden"
      />,
    );
    expect(container.querySelector(".turn--custom")).toBeNull();
  });

  it("keeps singleton custom activity as a body-closed card in Compact", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "intercom_message",
            content: "one",
            display: true,
            timestamp: 19,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="compact"
      />,
    );
    const card = container.querySelector(".card--custom");
    expect(card?.querySelector(".card__disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(container.querySelector(".activity-strip")).toBeNull();
  });

  it("collapses adjacent custom activity into typed tiles without invented result status", async () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "intercom_message",
            content: "one",
            display: true,
            timestamp: 20,
          },
          {
            role: "custom",
            customType: "hidden_context",
            content: "hidden",
            display: false,
            timestamp: 21,
          },
          {
            role: "custom",
            customType: "web_search_content_ready",
            content: "two",
            display: true,
            timestamp: 22,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const strip = container.querySelector(".activity-strip") as HTMLElement;
    expect(
      strip.querySelectorAll(".activity-strip__item--custom"),
    ).toHaveLength(2);
    expect(screen.queryByText("hidden_context")).not.toBeInTheDocument();

    const intercom = screen.getByRole("button", {
      name: "Intercom message: custom activity",
    });
    expect(within(intercom).getByText("intercom_message")).toHaveClass(
      "activity-strip__kind",
    );
    expect(
      intercom.querySelector(
        ".status-success, .status-error, .status-unknown, .spin",
      ),
    ).toBeNull();
    fireEvent.click(intercom);
    const detail = strip.querySelector(
      ".activity-strip__detail",
    ) as HTMLElement;
    expect(detail).toHaveClass("card--custom");
    expect(detail.querySelector(".card__custom-kind")).toHaveTextContent(
      "intercom_message",
    );
    expect(within(detail).getByText("one")).toBeInTheDocument();
    fireEvent.click(
      within(detail).getByRole("button", {
        name: "Collapse Intercom message custom activity details",
      }),
    );
    expect(intercom).toHaveAttribute("aria-expanded", "false");
    await waitFor(() =>
      expect(screen.queryByText("one")).not.toBeInTheDocument(),
    );
  });

  it("merges trailing custom activity into the preceding final tool strip", () => {
    const toolBatch = {
      role: "assistant",
      timestamp: 25,
      content: [
        {
          type: "toolCall",
          id: "merged-read",
          name: "read",
          arguments: { path: "a.ts" },
        },
        {
          type: "toolCall",
          id: "merged-bash",
          name: "bash",
          arguments: { command: "npm test" },
        },
      ],
    };
    const { container } = render(
      <Transcript
        messages={[
          toolBatch,
          {
            role: "toolResult",
            toolCallId: "merged-read",
            content: "read",
            timestamp: 26,
          },
          {
            role: "toolResult",
            toolCallId: "merged-bash",
            content: "tested",
            timestamp: 27,
          },
          {
            role: "custom",
            customType: "intercom_message",
            content: "delivered",
            display: true,
            timestamp: 28,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const strips = container.querySelectorAll(".activity-strip");
    expect(strips).toHaveLength(1);
    const items = strips[0]!.querySelectorAll(".activity-strip__item");
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveAccessibleName("Intercom message: custom activity");
    expect(container.querySelector(".turn--custom")).toBeNull();
  });

  it("keeps a trailing live custom message in its tool batch through Dynamic collapse", () => {
    vi.useFakeTimers();
    const active = {
      role: "assistant",
      timestamp: 29,
      __inspireLiveId: "merged-live",
      content: [
        {
          type: "toolCall",
          id: "merged-live-tool",
          name: "read",
          arguments: { path: "live.ts" },
        },
      ],
    };
    const result = {
      role: "toolResult",
      toolCallId: "merged-live-tool",
      content: "done",
      timestamp: 30,
    };
    const started = {
      role: "custom",
      customType: "intercom_message",
      content: "delivered",
      display: true,
      timestamp: 31,
      __inspireLiveId: "merged-custom-live",
    };
    const preferences = {
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript
        messages={[active, result, started]}
        streaming
        activeAssistantMessageKey="live:merged-live"
        {...preferences}
      />,
    );
    const headers = container.querySelectorAll(
      ".card--tool .card__disclosure, .card--custom .card__disclosure",
    );
    expect(headers).toHaveLength(2);
    for (const header of headers)
      expect(header).toHaveAttribute("aria-expanded", "true");

    const ended = { ...started, __inspireSettled: true };
    rerender(
      <Transcript
        messages={[active, result, ended]}
        streaming
        activeAssistantMessageKey="live:merged-live"
        {...preferences}
      />,
    );
    act(() => vi.advanceTimersByTime(1_500));
    for (const header of headers)
      expect(header).toHaveAttribute("aria-expanded", "false");

    rerender(
      <Transcript
        messages={[
          active,
          result,
          ended,
          {
            role: "assistant",
            content: "next",
            timestamp: 32,
            __inspireLiveId: "next",
          },
        ]}
        streaming
        activeAssistantMessageKey="live:next"
        {...preferences}
      />,
    );
    act(() => vi.advanceTimersByTime(980));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).not.toBeNull();
    act(() => vi.advanceTimersByTime(180));
    const strips = container.querySelectorAll(".activity-strip");
    expect(strips).toHaveLength(1);
    expect(strips[0]!.querySelectorAll(".activity-strip__item")).toHaveLength(
      2,
    );
    expect(
      strips[0]!.querySelectorAll(".activity-strip__item--custom"),
    ).toHaveLength(1);
    expect(container.querySelector(".turn--custom")).toBeNull();
  });

  it("loads a historical Dynamic singleton custom activity as Collapsed", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "custom",
            customType: "web_search_content_ready",
            content: "ready",
            display: true,
            timestamp: 30,
          },
        ]}
        streaming={false}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
      />,
    );
    const card = container.querySelector(".card--custom");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".card__disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(container.querySelector(".activity-strip")).toBeNull();
  });

  it("streams a singleton custom activity from Expanded to Compact without reducing it to a strip", () => {
    vi.useFakeTimers();
    const started = {
      role: "custom",
      customType: "web_search_content_ready",
      content: "streamed payload",
      display: true,
      timestamp: 40,
      __inspireLiveId: "custom-live",
    };
    const props = {
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { container, rerender } = render(
      <Transcript messages={[started]} streaming {...props} />,
    );
    const header = container.querySelector(
      ".card--custom .card__disclosure",
    ) as HTMLButtonElement;
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/streamed payload/)).toBeInTheDocument();
    expect(container.querySelector(".activity-strip")).toBeNull();
    act(() => vi.advanceTimersByTime(1_500));

    const ended = { ...started, __inspireSettled: true };
    rerender(<Transcript messages={[ended]} streaming {...props} />);
    act(() => vi.advanceTimersByTime(499));
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".activity-strip")).toBeNull();

    rerender(
      <Transcript
        messages={[
          ended,
          {
            role: "assistant",
            content: "next call",
            timestamp: 41,
            __inspireLiveId: "next",
          },
        ]}
        streaming
        {...props}
      />,
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(
      container.querySelector(".dynamic-activity-batch--collapsing"),
    ).toBeNull();
    expect(container.querySelector(".activity-strip")).toBeNull();
    expect(container.querySelectorAll(".card--custom")).toHaveLength(1);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps one Dynamic lifecycle when a custom activity adopts its durable timestamp", () => {
    vi.useFakeTimers();
    const props = {
      streaming: true,
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const started = {
      role: "custom",
      customType: "intercom_message",
      content: "owned once",
      display: true,
      timestamp: 50,
      __inspireLiveId: "custom-live-owned",
      __inspireMessageId: "custom-owned:0",
      __inspireEntryId: "custom-owned",
    };
    const { container, rerender } = render(
      <Transcript messages={[started]} {...props} />,
    );
    const header = container.querySelector(
      ".card--custom .card__disclosure",
    ) as HTMLButtonElement;
    expect(header).toHaveAttribute("aria-expanded", "true");

    rerender(
      <Transcript
        messages={[
          {
            ...started,
            timestamp: 5_000,
            __inspireLiveId: undefined,
            __inspireSettled: undefined,
          },
        ]}
        {...props}
      />,
    );
    expect(container.querySelector(".card--custom .card__disclosure")).toBe(
      header,
    );
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1_499));
    expect(header).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll(".card--custom")).toHaveLength(1);
  });

  it("renders placed text widgets and an attributable raw fallback", () => {
    const displays = [
      {
        id: "setWidget:plan",
        kind: "widget" as const,
        label: "plan",
        source: "extensions/plan.ts",
        placement: "aboveEditor" as const,
        lines: ["\u001b[32mone\u001b[0m", "two"],
      },
      {
        id: "setWidget:usage",
        kind: "widget" as const,
        label: "usage",
        source: "Pi extension",
        placement: "belowEditor" as const,
        lines: ["5h 37%"],
      },
      {
        id: "showPanel:build",
        kind: "raw" as const,
        label: "build",
        source: "extensions/build.ts",
        placement: "aboveEditor" as const,
        method: "showPanel",
        payload: { status: "passing" },
      },
    ];
    render(
      <>
        <Transcript
          messages={[]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="hidden"
          extensionDisplays={displays}
        />
        <ExtensionDisplayDock displays={displays} placement="aboveEditor" />
        <ExtensionDisplayDock displays={displays} placement="belowEditor" />
      </>,
    );
    const above = screen.getByRole("region", {
      name: "Extension content above composer",
    });
    const below = screen.getByRole("region", {
      name: "Extension content below composer",
    });
    expect(within(above).getByText("plan")).toBeInTheDocument();
    expect(within(above).getByText("extensions/plan.ts")).toBeInTheDocument();
    expect(
      within(above).getByRole("region", {
        name: "plan widget from extensions/plan.ts",
      }),
    ).toBeInTheDocument();
    expect(
      within(above).getByRole("button", {
        name: "Copy plan widget from extensions/plan.ts",
      }),
    ).toBeInTheDocument();
    const widgetText = above.querySelector(".extension-display__text");
    expect(widgetText).toHaveTextContent("one two");
    expect(widgetText?.textContent).not.toContain("\u001b[32m");
    expect(within(below).getByText("usage")).toBeInTheDocument();
    expect(within(below).getByText("5h 37%")).toBeInTheDocument();
    const fallback = screen.getByRole("region", {
      name: "Extension display content",
    });
    expect(
      within(fallback).getByText("extensions/build.ts · build"),
    ).toBeInTheDocument();
    expect(within(fallback).queryByText("plan")).not.toBeInTheDocument();
    fireEvent.click(within(fallback).getByText("extensions/build.ts · build"));
    expect(within(fallback).getByText(/passing/)).toBeInTheDocument();
  });
});
