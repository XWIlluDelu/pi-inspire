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

function ViewportHarness({ viewId = "view" }: { viewId?: string }) {
  const searchOwnsViewportRef = useRef(false);
  const viewport = useTranscriptViewport({
    rows: ROWS,
    sessionId: "session",
    viewId,
    hasOlder: false,
    olderError: null,
    onLoadOlder: async () => false,
    followSignal: "stable",
    searchOwnsViewportRef,
  });

  return (
    <div
      ref={viewport.scrollRef}
      role="log"
      data-pinned={viewport.pinned}
      onScroll={viewport.onScroll}
      onWheel={viewport.markUserScrollIntent}
    >
      <div ref={viewport.contentRef}>
        <div data-transcript-key="one">message</div>
        <button
          type="button"
          data-testid="layout-anchor"
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

function OlderLoadingHarness({
  hasOlder,
  onLoadOlder,
}: {
  hasOlder: boolean;
  onLoadOlder: () => Promise<boolean>;
}) {
  const searchOwnsViewportRef = useRef(false);
  const viewport = useTranscriptViewport({
    rows: ROWS,
    sessionId: "session",
    viewId: "view",
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
      data-loading-earlier={viewport.loadingEarlier}
    >
      <div ref={viewport.contentRef}>
        <div data-transcript-key="one">message</div>
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
    vi.unstubAllGlobals();
  });

  it("keeps a pinned transcript at latest after its scrollport shrinks", () => {
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });

    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 180,
    });
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });

    expect(log.scrollTop).toBe(820);
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
      <OlderLoadingHarness hasOlder onLoadOlder={onLoadOlder} />,
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

    rerender(
      <OlderLoadingHarness hasOlder={false} onLoadOlder={onLoadOlder} />,
    );
    await act(async () => releases[1]!(true));
    act(() => {
      flushAnimationFrames();
      flushAnimationFrames();
      flushAnimationFrames();
    });
    expect(log).toHaveAttribute("data-loading-earlier", "false");
  });

  it("does not reclaim latest-follow after an unpinned scrollport resize", () => {
    render(<ViewportHarness />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });

    fireEvent.wheel(log);
    log.scrollTop = 400;
    fireEvent.scroll(log);

    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 180,
    });
    act(() => {
      TestResizeObserver.trigger(log);
      flushAnimationFrames();
    });

    expect(log.scrollTop).toBe(400);
  });

  it("treats another branch view as a new latest-follow projection", () => {
    const { rerender } = render(<ViewportHarness viewId="branch-a" />);
    const log = screen.getByRole("log");
    setScrollGeometry(log, { clientHeight: 400, scrollTop: 600 });

    fireEvent.wheel(log);
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log).toHaveAttribute("data-pinned", "false");

    rerender(<ViewportHarness viewId="branch-b" />);
    expect(log).toHaveAttribute("data-pinned", "true");
    expect(log.scrollTop).toBe(600);
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
      const anchor = screen.getByTestId("layout-anchor");
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
