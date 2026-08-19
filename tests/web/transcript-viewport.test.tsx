// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
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

function ViewportHarness() {
  const searchOwnsViewportRef = useRef(false);
  const viewport = useTranscriptViewport({
    rows: ROWS,
    sessionId: "session",
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
      onScroll={viewport.onScroll}
      onWheel={viewport.markUserScrollIntent}
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
});
