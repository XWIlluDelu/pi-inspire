// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TranscriptViewportRow,
  useTranscriptViewport,
} from "../../src/components/transcript-viewport";
import { deferred } from "./helpers";

const ROWS: TranscriptViewportRow[] = [{ key: "one" }];

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
  hasOlder = false,
  onLoadOlder = async () => false,
}: {
  sessionId?: string;
  viewId?: string;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<boolean>;
}) {
  const searchOwnsViewportRef = useRef(false);
  const viewport = useTranscriptViewport({
    rows: ROWS,
    sessionId,
    viewId,
    hasOlder,
    olderError: null,
    onLoadOlder,
    followSignal: "stable",
    searchOwnsViewportRef,
  });
  return (
    <div
      ref={viewport.scrollRef}
      role="log"
      data-pinned={viewport.pinned}
      data-at-latest={viewport.atLatest}
      data-loading-earlier={viewport.loadingEarlier}
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
        <button
          type="button"
          onClick={(event) =>
            viewport.preserveAnchorThroughLayout(event.currentTarget, "end")
          }
        >
          Resize row
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

  it("follows the latest boundary on resize while the reader is pinned", () => {
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });
    const resize = (height: number) => {
      Object.defineProperty(log, "clientHeight", {
        configurable: true,
        value: height,
      });
      act(() => {
        TestResizeObserver.trigger(log);
        flushAnimationFrames();
      });
    };

    resize(300);
    expect(log.scrollTop).toBe(700);

    fireEvent.wheel(log, { deltaY: -300 });
    log.scrollTop = 400;
    fireEvent.scroll(log);
    resize(180);
    expect(log.scrollTop).toBe(400);
    expect(log).toHaveAttribute("data-pinned", "false");
  });

  it("keeps an upward wheel intent across a queued layout scroll at latest", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);

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
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });

    expect(log.scrollTop).toBe(110);
    expect(log).toHaveAttribute("data-pinned", "false");
    expect(log).toHaveAttribute("data-at-latest", "false");
    act(() => vi.runOnlyPendingTimers());
    expect(log.scrollTop).toBe(110);

    fireEvent.wheel(log, { deltaY: 440 });
    log.scrollTop = 550;
    fireEvent.scroll(log);
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });
    expect(log.scrollTop).toBe(550);
    expect(log).toHaveAttribute("data-pinned", "false");

    fireEvent.wheel(log, { deltaY: 60 });
    log.scrollTop = 610;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-pinned", "true");
    expect(log).toHaveAttribute("data-at-latest", "true");
  });

  it("retains follow when an upward wheel cannot move a short transcript", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 1_000, scrollTop: 0 });
    fireEvent.scroll(log);
    fireEvent.wheel(log, { deltaY: -500 });
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-pinned", "true");

    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_100,
    });
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });
    expect(log.scrollTop).toBe(0);
    act(() => vi.runOnlyPendingTimers());
    expect(log.scrollTop).toBe(100);
    expect(log).toHaveAttribute("data-at-latest", "true");
  });

  it("keeps one loading state across consecutive automatic older pages", async () => {
    const releases: Array<(loaded: boolean) => void> = [];
    const onLoadOlder = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { rerender } = render(
      <ViewportHarness hasOlder onLoadOlder={onLoadOlder} />,
    );
    const log = screen.getByRole("log");
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    expect(log).toHaveAttribute("data-loading-earlier", "true");

    await act(async () => releases[0]!(true));
    act(() => {
      flushAnimationFrames();
      flushAnimationFrames();
    });
    expect(log).toHaveAttribute("data-loading-earlier", "true");
    act(() => flushAnimationFrames());
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2));
    expect(log).toHaveAttribute("data-loading-earlier", "true");

    rerender(<ViewportHarness hasOlder={false} onLoadOlder={onLoadOlder} />);
    await act(async () => releases[1]!(true));
    act(() => {
      flushAnimationFrames();
      flushAnimationFrames();
      flushAnimationFrames();
    });
    expect(log).toHaveAttribute("data-loading-earlier", "false");
  });

  it("keeps the new view's loading owner when a retired page settles", async () => {
    const oldPage = deferred<boolean>(),
      currentPage = deferred<boolean>();
    const onLoadOlder = vi
      .fn()
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(currentPage.promise);
    const view = render(
      <ViewportHarness hasOlder viewId="old" onLoadOlder={onLoadOlder} />,
    );
    view.rerender(
      <ViewportHarness hasOlder viewId="current" onLoadOlder={onLoadOlder} />,
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
    await act(async () => oldPage.resolve(false));
    expect(screen.getByRole("log")).toHaveAttribute(
      "data-loading-earlier",
      "true",
    );
    await act(async () => currentPage.resolve(false));
    expect(screen.getByRole("log")).toHaveAttribute(
      "data-loading-earlier",
      "false",
    );
  });

  it.each([
    { navigation: "search", afterResponse: false },
    { navigation: "search", afterResponse: true },
    { navigation: "scroll", afterResponse: false },
    { navigation: "latest", afterResponse: false },
  ])(
    "keeps newer $navigation navigation across an earlier-history completion (after response: $afterResponse)",
    async ({ navigation, afterResponse }) => {
      const page = deferred<boolean>();
      const onLoadOlder = vi.fn(() => page.promise);
      const view = render(
        <ViewportHarness hasOlder={false} onLoadOlder={onLoadOlder} />,
      );
      const log = screen.getByRole("log");
      setScrollGeometry(log, { clientHeight: 400, scrollTop: 100 });
      view.rerender(<ViewportHarness hasOlder onLoadOlder={onLoadOlder} />);
      expect(onLoadOlder).toHaveBeenCalledOnce();

      const complete = async () => {
        Object.defineProperty(log, "scrollHeight", {
          configurable: true,
          value: 1_400,
        });
        await act(async () => page.resolve(true));
      };
      if (afterResponse) {
        await complete();
        act(() => flushAnimationFrames());
      }
      if (navigation === "scroll") {
        fireEvent.wheel(log);
        log.scrollTop = 500;
      } else {
        fireEvent.click(
          screen.getByRole("button", {
            name:
              navigation === "search" ? "Navigate search" : "Jump to latest",
          }),
        );
      }
      fireEvent.scroll(log);
      if (!afterResponse) {
        // Native anchoring preserves the current row when history prepends.
        log.scrollTop += 400;
        await complete();
      }
      act(() => {
        TestResizeObserver.trigger(log);
        flushAnimationFrames();
        flushAnimationFrames();
        flushAnimationFrames();
      });
      fireEvent.scroll(log);
      expect(log.scrollTop).toBe(navigation === "latest" ? 1_000 : 900);
      expect(log).toHaveAttribute("data-loading-earlier", "false");
      expect(onLoadOlder).toHaveBeenCalledOnce();
    },
  );

  it("retires an older page's queued scroll after a view change", async () => {
    const page = deferred<boolean>();
    const onLoadOlder = vi.fn(() => page.promise);
    const view = render(
      <ViewportHarness hasOlder viewId="old" onLoadOlder={onLoadOlder} />,
    );
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 100 });
    await act(async () => page.resolve(true));
    act(() => flushAnimationFrames());
    view.rerender(
      <ViewportHarness
        hasOlder={false}
        viewId="current"
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(log.scrollTop).toBe(600);
    act(() => {
      flushAnimationFrames();
      flushAnimationFrames();
      flushAnimationFrames();
    });
    expect(log.scrollTop).toBe(600);
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it("reports the visible latest boundary independently of follow ownership", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);
    fireEvent.wheel(log);
    log.scrollTop = 550;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-pinned", "false");
    expect(log).toHaveAttribute("data-at-latest", "false");

    // Programmatic navigation can reach latest without acquiring live-follow.
    act(() => vi.advanceTimersByTime(450));
    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-pinned", "false");
    expect(log).toHaveAttribute("data-at-latest", "true");
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1_100,
    });
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });
    expect(log.scrollTop).toBe(600);
    expect(log).toHaveAttribute("data-at-latest", "false");
  });

  it.each([
    { scrollTop: 560, expectedTop: 560, expectedPinned: "false" },
    { scrollTop: 599.5, expectedTop: 700, expectedPinned: "true" },
  ])(
    "restores follow after clearing search only at the latest boundary ($scrollTop)",
    ({ scrollTop, expectedTop, expectedPinned }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      render(<ViewportHarness />);
      const log = screen.getByRole("log");
      setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });
      fireEvent.scroll(log);
      fireEvent.wheel(log);
      log.scrollTop = scrollTop;
      fireEvent.scroll(log);
      expect(log).toHaveAttribute("data-pinned", "false");
      act(() => vi.advanceTimersByTime(450));

      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(log).toHaveAttribute("data-pinned", expectedPinned);
      Object.defineProperty(log, "scrollHeight", {
        configurable: true,
        value: 1_100,
      });
      act(() => {
        TestResizeObserver.trigger(log);
        flushAnimationFrames();
      });
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
    expect(log).toHaveAttribute("data-pinned", "false");
    expect(log).toHaveAttribute("data-at-latest", "false");

    rerender(<ViewportHarness {...projection} />);
    expect(log).toHaveAttribute("data-pinned", "true");
    expect(log).toHaveAttribute("data-at-latest", "true");
    expect(log.scrollTop).toBe(600);

    // A later gesture must still publish the new projection's boundary change.
    fireEvent.wheel(log);
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-at-latest", "false");
  });

  it.each([
    {
      name: "releases latest-follow away from the boundary",
      nextScrollHeight: 1_000,
      expectedPinned: "false",
    },
    {
      name: "retains latest-follow when the disclosure stays at latest",
      nextScrollHeight: 800,
      expectedPinned: "true",
    },
  ])(
    "anchors a disclosure edge and $name",
    ({ nextScrollHeight, expectedPinned }) => {
      render(<ViewportHarness />);
      const log = screen.getByRole("log");
      const anchor = screen.getByRole("button", { name: "Resize row" });
      setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });
      vi.spyOn(log, "getBoundingClientRect").mockReturnValue({
        top: 100,
      } as DOMRect);
      let anchorBottom = 500;
      vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            top: anchorBottom - 40,
            bottom: anchorBottom,
          }) as DOMRect,
      );

      fireEvent.click(anchor);
      expect(log).toHaveAttribute("data-pinned", "false");
      anchorBottom = 300;
      Object.defineProperty(log, "scrollHeight", {
        configurable: true,
        value: nextScrollHeight,
      });
      act(() => {
        flushAnimationFrames();
        flushAnimationFrames();
      });

      expect(log.scrollTop).toBe(400);
      expect(log).toHaveAttribute("data-pinned", expectedPinned);
    },
  );
});
