// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import { store } from "../../src/store";
import { useTranscriptViewport } from "../../src/components/transcript-viewport";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  static trigger(target: Element): void {
    for (const observer of TestResizeObserver.instances) {
      if (observer.targets.has(target))
        observer.callback([], observer as unknown as ResizeObserver);
    }
  }
}

let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;

function flushAnimationFrames(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(Date.now());
}

function ViewportHarness({
  sessionId = "session",
  viewId = "view",
}: {
  sessionId?: string;
  viewId?: string;
}) {
  const searchOwnsViewportRef = useRef(false);
  const viewport = useTranscriptViewport({
    sessionId,
    viewId,
    followSignal: "stable",
    searchOwnsViewportRef,
  });
  return (
    <div
      ref={viewport.scrollRef}
      role="log"
      data-at-latest={viewport.atLatest}
      onScroll={viewport.onScroll}
      onWheel={(event) =>
        viewport.markUserScrollIntent(
          event.deltaY < 0
            ? "history"
            : event.deltaY > 0
              ? "latest"
              : "unknown",
        )
      }
    >
      <div ref={viewport.contentRef}>
        <div data-transcript-key="one">message</div>
        <button
          type="button"
          onClick={() => {
            searchOwnsViewportRef.current = true;
            viewport.releaseLatestFollow();
            const log = viewport.scrollRef.current!;
            log.scrollTop = log.scrollHeight - 500;
          }}
        >
          Navigate search
        </button>
        <button type="button" onClick={viewport.restoreGeometricFollow}>
          Clear search
        </button>
        <button type="button" onClick={viewport.jumpToLatest}>
          Jump to latest
        </button>
      </div>
    </div>
  );
}

function setScrollGeometry(
  element: HTMLElement,
  { clientHeight, scrollTop }: { clientHeight: number; scrollTop: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: clientHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

function openViewport(clientHeight = 400) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  render(<ViewportHarness />);
  const log = screen.getByRole("log");
  setScrollGeometry(log, { clientHeight, scrollTop: 1_000 - clientHeight });
  fireEvent.scroll(log);
  return log;
}

function deliverLayout(log: HTMLElement) {
  act(() => {
    TestResizeObserver.trigger(log);
    flushAnimationFrames();
  });
}

describe("transcript viewport geometry", () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    animationFrames = new Map();
    nextAnimationFrame = 1;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextAnimationFrame++;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      animationFrames.delete(id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prepends an older saved page without replacing the live scrollport or moving its row", async () => {
    const reply = {
      role: "assistant",
      __inspireEntryId: "recent",
      __inspireMessageId: "recent:0",
      content: "Current reply",
    };
    const read = vi
      .spyOn(store.branches, "history")
      .mockImplementation(async (_, __, query) => {
        if (query.kind !== "page") return null;
        return {
          sessionId: "session",
          viewId: "view",
          incarnation: "incarnation",
          revision: 1,
          leafId: "recent",
          messages: [
            {
              ...reply,
              __inspireEntryId: "older",
              __inspireMessageId: "older:0",
              content: "Earlier reply",
            },
          ],
          earlier: null,
          later: null,
        };
      });
    try {
      render(
        <Transcript
          messages={[reply]}
          sessionId="session"
          viewId="view"
          projectionIncarnation="incarnation"
          hasOlder
          streaming={false}
          thinkingVisibility="expanded"
          toolVisibility="collapsed"
        />,
      );
      const log = screen.getByRole("log");
      const visible = screen
        .getByText("Current reply")
        .closest<HTMLElement>("[data-transcript-key]")!;
      log.scrollTop = 20;
      vi.spyOn(visible, "getBoundingClientRect").mockImplementation(
        () =>
          new DOMRect(
            0,
            screen.queryByText("Earlier reply") ? 430 : 30,
            200,
            100,
          ),
      );
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -150 });
      });
      expect(read).toHaveBeenCalledWith(
        "session",
        "view",
        {
          kind: "page",
          direction: "earlier",
          entryId: "recent",
        },
        expect.any(AbortSignal),
      );
      expect(screen.getByText("Earlier reply")).toBeVisible();
      expect(screen.getByRole("log")).toBe(log);
      expect(log.scrollTop).toBe(420);
    } finally {
      read.mockRestore();
    }
  });

  it("keeps an upward wheel intent across a queued layout scroll at latest", () => {
    const log = openViewport();

    fireEvent.wheel(log, { deltaY: -500 });
    // Disclosure reflow can move the bottom before the browser delivers the
    // wheel's own scroll. This is movement, but not a return chosen by the user.
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_010,
    });
    log.scrollTop = 610;
    fireEvent.scroll(log);
    log.scrollTop = 110;
    fireEvent.scroll(log);
    deliverLayout(log);

    expect(log.scrollTop).toBe(110);
    expect(log).toHaveAttribute("data-at-latest", "false");
    act(() => vi.runOnlyPendingTimers());
    expect(log.scrollTop).toBe(110);

    fireEvent.wheel(log, { deltaY: 440 });
    log.scrollTop = 550;
    fireEvent.scroll(log);
    deliverLayout(log);
    expect(log.scrollTop).toBe(550);

    fireEvent.wheel(log, { deltaY: 60 });
    log.scrollTop = 610;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "true");
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_110,
    });
    deliverLayout(log);
    expect(log.scrollTop).toBe(710);
  });

  it("retains follow when an upward wheel cannot move a short transcript", () => {
    const log = openViewport(1_000);
    fireEvent.wheel(log, { deltaY: -500 });
    fireEvent.scroll(log);

    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_100,
    });
    deliverLayout(log);
    expect(log.scrollTop).toBe(0);
    act(() => vi.runOnlyPendingTimers());
    expect(log.scrollTop).toBe(100);
    expect(log).toHaveAttribute("data-at-latest", "true");
  });

  it("reports the visible latest boundary independently of follow ownership", () => {
    const log = openViewport();
    fireEvent.wheel(log);
    log.scrollTop = 550;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "false");

    // Programmatic navigation can reach latest without acquiring live-follow.
    act(() => vi.advanceTimersByTime(450));
    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "true");
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_100,
    });
    deliverLayout(log);
    expect(log.scrollTop).toBe(600);
    expect(log).toHaveAttribute("data-at-latest", "false");
  });

  it.each([
    { scrollTop: 560, expectedTop: 560 },
    { scrollTop: 599.5, expectedTop: 700 },
  ])(
    "restores follow after clearing search only at the latest boundary ($scrollTop)",
    ({ scrollTop, expectedTop }) => {
      const log = openViewport();
      fireEvent.wheel(log);
      log.scrollTop = scrollTop;
      fireEvent.scroll(log);
      act(() => vi.advanceTimersByTime(450));

      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      Object.defineProperty(log, "scrollHeight", {
        configurable: true,
        value: 1_100,
      });
      deliverLayout(log);
      expect(log.scrollTop).toBe(expectedTop);
    },
  );

  it.each([
    { sessionId: "session", viewId: "branch-b" },
    { sessionId: "another-session", viewId: "branch-a" },
  ])("resets the latest boundary for a new projection %j", (projection) => {
    const { rerender } = render(<ViewportHarness viewId="branch-a" />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });

    fireEvent.wheel(log);
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "false");

    rerender(<ViewportHarness {...projection} />);
    expect(log).toHaveAttribute("data-at-latest", "true");
    expect(log.scrollTop).toBe(600);

    // A later gesture must still publish the new projection's boundary change.
    fireEvent.wheel(log);
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "false");
  });
});
