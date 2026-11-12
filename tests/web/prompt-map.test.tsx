// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptMap } from "../../src/components/PromptMap";
import { Transcript } from "../../src/components/Transcript";
import { deferred, openTranscriptSearch } from "./helpers";

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
    expect(
      await screen.findByRole("list", { name: "User prompts" }),
    ).toBeVisible();

    rerender(<Transcript {...props} viewId="branch-b" />);
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

function delayedPromptSeek() {
  const loaded = deferred<boolean>();
  const navigate = vi.fn(() => loaded.promise);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const bounds = new DOMRect(0, 0, 600, 300);
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => bounds;
    return range;
  });
  vi.stubGlobal("Highlight", class extends Set<Range> {});
  vi.stubGlobal("CSS", { ...CSS, highlights: new Map() });
  const message = (ordinal: number) => ({
    role: "user",
    content: ordinal === 0 ? "earlier prompt" : "loaded needle",
    timestamp: ordinal + 1,
    __inspireMessageId: `u${ordinal}`,
    __inspireMessageIndex: ordinal,
    __inspireUserTurnId: `u${ordinal}`,
    __inspireUserTurnIndex: ordinal,
  });
  const turns = [0, 1].map((ordinal) => ({
    id: `u${ordinal}`,
    ordinal,
    snippet: message(ordinal).content,
    attachmentCount: 0,
  }));
  const transcript = (
    messages: ReturnType<typeof message>[],
    sessionId = "s1",
  ) => (
    <Transcript
      sessionId={sessionId}
      viewId={`view-${sessionId}`}
      messages={messages}
      promptMapTurns={turns}
      promptMapTotal={2}
      promptMapLoadedStarts={[0]}
      onNavigatePromptMapTurn={navigate}
      streaming={false}
      thinkingVisibility="collapsed"
      toolVisibility="collapsed"
    />
  );
  const { rerender } = render(transcript([message(1)]));
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 },
  });
  vi.spyOn(log, "getBoundingClientRect").mockReturnValue(bounds);
  const scrolledTurns: string[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.userTurnIndex !== undefined)
        scrolledTurns.push(this.dataset.userTurnIndex);
    },
  );
  act(flushFrames);
  // Begin reading above latest so each later action has a visible destination.
  fireEvent.wheel(log, { deltaY: -200 });
  log.scrollTop = 400;
  fireEvent.scroll(log);
  act(flushFrames);
  fireEvent.click(screen.getByRole("button", { name: "Previous user prompt" }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith(0);
  return {
    log,
    scrolledTurns,
    flushFrames,
    switchOwner: () => rerender(transcript([message(0), message(1)], "s2")),
    async releasePage(afterSwitch = false) {
      await act(async () => {
        if (!afterSwitch) rerender(transcript([message(0), message(1)]));
        loaded.resolve(true);
      });
    },
  };
}

describe("Transcript Prompt Map continuation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["search", "wheel", "latest"] as const)(
    "keeps a newer %s intent when an earlier prompt page arrives",
    async (intent) => {
      const { log, scrolledTurns, flushFrames, releasePage } =
        delayedPromptSeek();
      if (intent === "search") {
        const input = openTranscriptSearch();
        expect(input).toBeEnabled();
        fireEvent.change(input, { target: { value: "needle" } });
        fireEvent.keyDown(input, { key: "Enter" });
        act(flushFrames);
        expect(scrolledTurns).toEqual(["1"]);
      } else if (intent === "wheel") {
        fireEvent.wheel(log, { deltaY: -100 });
        log.scrollTop = 300;
        fireEvent.scroll(log);
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
        expect(log.scrollTop).toBe(700);
      }
      const position = log.scrollTop;
      scrolledTurns.length = 0;
      await releasePage();
      act(flushFrames);
      expect(scrolledTurns).toEqual([]);
      expect(log.scrollTop).toBe(position);
      if (intent === "search") {
        expect(screen.getByRole("searchbox")).toHaveValue("needle");
        expect(
          screen.getByLabelText("Transcript search matches"),
        ).toHaveTextContent("1 of 1");
        expect(
          [...CSS.highlights.get("transcript-current-match")!].map((range) =>
            range.toString(),
          ),
        ).toEqual(["needle"]);
      }
    },
  );

  it("scrolls to a delayed prompt when its reading intent is still current", async () => {
    const { scrolledTurns, flushFrames, releasePage } = delayedPromptSeek();
    await releasePage();
    act(flushFrames);
    expect(scrolledTurns).toEqual(["0"]);
  });

  it("retires a prompt scroll frame if a wheel gesture arrives after its page", async () => {
    const { log, scrolledTurns, flushFrames, releasePage } =
      delayedPromptSeek();
    await releasePage();
    expect(scrolledTurns).toEqual([]);
    fireEvent.wheel(log, { deltaY: -100 });
    act(flushFrames);
    expect(scrolledTurns).toEqual([]);
  });

  it("does not scroll the new session to an earlier session's prompt", async () => {
    const { scrolledTurns, flushFrames, switchOwner, releasePage } =
      delayedPromptSeek();
    switchOwner();
    act(flushFrames);
    scrolledTurns.length = 0;
    await releasePage(true);
    act(flushFrames);
    expect(scrolledTurns).toEqual([]);
  });
});
