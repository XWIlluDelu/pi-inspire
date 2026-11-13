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

it("loads bounded outline pages and selects a native turn", async () => {
  const onLoad = vi.fn(async () => []);
  const onNavigate = vi.fn(async () => true);
  const onClose = vi.fn();
  const turns = [0, 100].map((ordinal) => ({
    id: String(ordinal),
    ordinal,
    snippet: `Prompt ${ordinal + 1}`,
    attachmentCount: 0,
  }));
  render(
    <PromptMap
      turns={turns}
      total={101}
      activeOrdinal={100}
      loadingStarts={[]}
      navigatingOrdinal={null}
      error={null}
      onLoad={onLoad}
      onNavigate={onNavigate}
      onClose={onClose}
    />,
  );
  expect(onLoad).toHaveBeenCalledExactlyOnceWith(100);
  expect(screen.getByRole("button", { name: /Prompt 101/ })).toHaveAttribute(
    "aria-current",
    "location",
  );
  fireEvent.click(screen.getByRole("button", { name: "Earlier prompts" }));
  expect(onLoad).toHaveBeenLastCalledWith(0);
  fireEvent.click(screen.getByRole("button", { name: /Prompt 1$/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith(0);
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
  fireEvent.click(
    screen.getByRole("button", { name: "Open prompt navigation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /earlier prompt/ }));
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

  it("keeps the current position when the prompt chooser is dismissed during a read", async () => {
    const { log, scrolledTurns, flushFrames, releasePage } =
      delayedPromptSeek();
    const position = log.scrollTop;
    fireEvent.click(screen.getByRole("button", { name: "Close user prompts" }));
    await releasePage();
    act(flushFrames);
    expect(scrolledTurns).toEqual([]);
    expect(log.scrollTop).toBe(position);
    expect(screen.queryByRole("dialog", { name: "User prompts" })).toBeNull();
  });

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
