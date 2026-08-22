// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptMap } from "../../src/components/PromptMap";
import { Transcript } from "../../src/components/Transcript";

const turns = [
  { id: "u0", ordinal: 0, snippet: "First prompt", attachmentCount: 0 },
  { id: "u1", ordinal: 1, snippet: "Second prompt", attachmentCount: 1 },
  { id: "u2", ordinal: 2, snippet: "Third prompt", attachmentCount: 0 },
];

const longTurns = Array.from({ length: 21 }, (_, ordinal) => ({
  id: `long-${ordinal}`,
  ordinal,
  snippet: `Prompt ${ordinal + 1}`,
  attachmentCount: 0,
}));

describe("Prompt Map", () => {
  it("navigates without wrapping and exposes disabled boundaries semantically", async () => {
    const onLoad = vi.fn(async () => turns);
    const onNavigate = vi.fn(async () => true);
    const { rerender } = render(
      <PromptMap
        turns={turns}
        total={turns.length}
        activeOrdinal={0}
        loadedStarts={[0]}
        loadingStarts={[]}
        navigatingOrdinal={null}
        error={null}
        onLoad={onLoad}
        onNavigate={onNavigate}
      />,
    );

    const previous = screen.getByRole("button", {
      name: "Previous user prompt",
    });
    const next = screen.getByRole("button", { name: "Next user prompt" });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(onNavigate).toHaveBeenCalledWith(1);
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    rerender(
      <PromptMap
        turns={turns}
        total={turns.length}
        activeOrdinal={2}
        loadedStarts={[0]}
        loadingStarts={[]}
        navigatingOrdinal={null}
        error={null}
        onLoad={onLoad}
        onNavigate={onNavigate}
      />,
    );
    expect(previous).toBeEnabled();
    expect(next).toBeDisabled();

    const map = screen.getByRole("navigation", {
      name: "User prompt navigation",
    });
    const toggle = screen.getByRole("button", { name: "Open prompt map" });
    fireEvent.click(toggle);
    await waitFor(() => expect(map).toHaveClass("prompt-map--open"));
    expect(
      screen.queryByRole("button", { name: "Collapse prompt map" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(map, { key: "Escape" });
    await waitFor(() => expect(map).not.toHaveClass("prompt-map--open"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open prompt map" }),
      ).toHaveFocus(),
    );

    const hoverToggle = screen.getByRole("button", {
      name: "Open prompt map",
    });
    fireEvent.pointerEnter(hoverToggle, { pointerType: "mouse" });
    await waitFor(() => expect(map).toHaveClass("prompt-map--open"));
    fireEvent.pointerLeave(map, { pointerType: "mouse" });
    await waitFor(() => expect(map).not.toHaveClass("prompt-map--open"));
  });

  it("keeps a stable 12-prompt local tick window", () => {
    const onLoad = vi.fn(async () => longTurns);
    const onNavigate = vi.fn(async () => true);
    const props = {
      turns: longTurns,
      total: 20,
      loadedStarts: [0],
      loadingStarts: [] as number[],
      navigatingOrdinal: null,
      error: null,
      onLoad,
      onNavigate,
    };
    const { container, rerender } = render(
      <PromptMap {...props} activeOrdinal={0} />,
    );
    const visibleOrdinals = () =>
      [...container.querySelectorAll<HTMLElement>("[data-prompt-ordinal]")].map(
        (tick) => Number(tick.dataset.promptOrdinal),
      );

    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, ordinal) => ordinal),
    );
    for (let ordinal = 1; ordinal <= 11; ordinal += 1)
      rerender(<PromptMap {...props} activeOrdinal={ordinal} />);
    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, ordinal) => ordinal),
    );

    rerender(<PromptMap {...props} activeOrdinal={12} />);
    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );

    rerender(<PromptMap {...props} activeOrdinal={19} />);
    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 8),
    );

    rerender(<PromptMap {...props} total={21} activeOrdinal={19} />);
    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 8),
    );
    rerender(<PromptMap {...props} total={21} activeOrdinal={20} />);
    expect(visibleOrdinals()).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 9),
    );
    expect(
      container.querySelector<HTMLElement>(".prompt-map__tick--active")?.dataset
        .promptOrdinal,
    ).toBe("20");
  });

  it("locks duplicate navigation and retries the exact failed target", async () => {
    let settleNavigation!: (loaded: boolean) => void;
    const onNavigate = vi
      .fn<(ordinal: number) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            settleNavigation = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    const onLoad = vi.fn(async () => turns);
    const props = {
      turns,
      total: turns.length,
      activeOrdinal: 0,
      loadedStarts: [0],
      loadingStarts: [] as number[],
      navigatingOrdinal: null,
      error: null as string | null,
      onLoad,
      onNavigate,
    };
    render(<PromptMap {...props} />);
    const next = screen.getByRole("button", { name: "Next user prompt" });

    fireEvent.click(next);
    fireEvent.click(next);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(next).toBeDisabled();

    settleNavigation(false);
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Open prompt map" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retry prompt navigation" }),
    );
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("tracks the turn crossing the reading line for previous and next", async () => {
    const onNavigate = vi.fn(async () => true);
    const { container } = render(
      <Transcript
        messages={turns.flatMap((turn, index) => [
          {
            role: "user",
            content: turn.snippet,
            timestamp: index * 2 + 1,
            __inspireMessageId: turn.id,
            __inspireMessageIndex: index * 2,
            __inspireUserTurnId: turn.id,
            __inspireUserTurnIndex: turn.ordinal,
          },
          {
            role: "assistant",
            content: `Response ${index + 1}`,
            timestamp: index * 2 + 2,
            __inspireMessageId: `a${index}`,
            __inspireMessageIndex: index * 2 + 1,
            __inspireUserTurnId: turn.id,
            __inspireUserTurnIndex: turn.ordinal,
          },
        ])}
        promptMapTurns={turns}
        promptMapTotal={3}
        promptMapLoadedStarts={[0]}
        onLoadPromptMapTurns={vi.fn(async () => turns)}
        onNavigatePromptMapTurn={onNavigate}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const transcript = container.querySelector(".transcript") as HTMLElement;
    vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 300,
      height: 300,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-user-turn-index]"),
    ];
    const turnOccurrences = new Map<number, number>();
    rows.forEach((row) => {
      const ordinal = Number(row.dataset.userTurnIndex);
      const occurrence = turnOccurrences.get(ordinal) ?? 0;
      turnOccurrences.set(ordinal, occurrence + 1);
      const top =
        ordinal === 0
          ? -180 + occurrence * 24
          : ordinal === 1
            ? 80 + occurrence * 60
            : 360 + occurrence * 60;
      row.scrollIntoView = vi.fn();
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top,
        bottom: top + 44,
        height: 44,
        left: 0,
        right: 600,
        width: 600,
        x: 0,
        y: top,
        toJSON: () => ({}),
      });
    });
    const frame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    fireEvent.scroll(transcript);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Previous user prompt" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next user prompt" }));
    expect(
      rows.some(
        (row) =>
          row.dataset.userTurnIndex === "2" &&
          vi.mocked(row.scrollIntoView).mock.calls.length > 0,
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Previous user prompt" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Previous user prompt" }),
    );
    await waitFor(() =>
      expect(
        rows.some(
          (row) =>
            row.dataset.userTurnIndex === "0" &&
            vi.mocked(row.scrollIntoView).mock.calls.length > 0,
        ),
      ).toBe(true),
    );
    expect(onNavigate).not.toHaveBeenCalled();

    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_600 },
      clientHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    });
    fireEvent.scroll(transcript);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Next user prompt" }),
      ).toBeDisabled(),
    );
    expect(
      container.querySelector<HTMLElement>(".prompt-map__tick--active")?.dataset
        .promptOrdinal,
    ).toBe("2");
    frame.mockRestore();
  });

  it("resets disclosure ownership when the branch view changes", async () => {
    const props = {
      sessionId: "branch-session",
      messages: [
        {
          role: "user",
          content: "Branch prompt",
          timestamp: 1,
          __inspireMessageId: "branch-user",
          __inspireUserTurnId: "branch-user",
          __inspireUserTurnIndex: 0,
        },
      ],
      promptMapTurns: turns,
      promptMapTotal: turns.length,
      promptMapLoadedStarts: [0],
      streaming: false,
      thinkingVisibility: "collapsed" as const,
      toolVisibility: "collapsed" as const,
    };
    const { rerender } = render(<Transcript {...props} viewId="branch-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Open prompt map" }));
    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "User prompt navigation" }),
      ).toHaveClass("prompt-map--open"),
    );

    rerender(<Transcript {...props} viewId="branch-b" />);
    expect(
      screen.getByRole("navigation", { name: "User prompt navigation" }),
    ).not.toHaveClass("prompt-map--open");
    expect(
      screen.getByRole("button", { name: "Open prompt map" }),
    ).toBeInTheDocument();
  });

  it("marks sparse transcript windows instead of presenting them as adjacent", () => {
    render(
      <Transcript
        messages={[
          {
            role: "user",
            content: "old turn",
            timestamp: 1,
            __inspireMessageId: "u0",
            __inspireMessageIndex: 0,
            __inspireUserTurnId: "u0",
            __inspireUserTurnIndex: 0,
          },
          {
            role: "assistant",
            content: "old response",
            timestamp: 2,
            __inspireMessageId: "a0",
            __inspireMessageIndex: 1,
            __inspireUserTurnId: "u0",
            __inspireUserTurnIndex: 0,
          },
          {
            role: "user",
            content: "new turn",
            timestamp: 10,
            __inspireMessageId: "u3",
            __inspireMessageIndex: 10,
            __inspireUserTurnId: "u3",
            __inspireUserTurnIndex: 3,
          },
        ]}
        promptMapTurns={turns}
        promptMapTotal={4}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    expect(screen.getByText("Conversation segment not loaded")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Previous user prompt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next user prompt" }),
    ).toBeInTheDocument();
  });
});
