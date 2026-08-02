// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";

describe("Transcript older-page anchor", () => {
  it("preserves an unpinned visible anchor when a retained history receives a live append", () => {
    const base = [
      { role: "user", content: "old", timestamp: 1, __inspireMessageId: "m1:0" },
      { role: "assistant", content: "new", timestamp: 2, __inspireMessageId: "m2:0" },
    ];
    const { container, rerender } = render(
      <Transcript messages={base} streaming={false} thinkingVisibility="collapsed" toolVisibility="collapsed" />,
    );
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 300 });
    transcript.scrollTop = 200;
    fireEvent.scroll(transcript);
    rerender(
      <Transcript
        messages={[...base, { role: "assistant", content: "append", timestamp: 3, __inspireMessageId: "m3:0" }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(transcript.scrollTop).toBe(200);
  });

  it("loads near the top without a button and preserves the visible anchor", async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    let observed: Element | null = null;
    let intersectionCallback: IntersectionObserverCallback | null = null;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
      observe(target: Element) { observed = target; }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = "320px 0px 0px";
      readonly thresholds = [0];
    });
    let height = 200;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const onLoadOlder = vi.fn(async () => {
      await loading;
      return true;
    });
    const { container } = render(
      <Transcript
        messages={[{ role: "user", content: "newest", timestamp: 2 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => height });
    transcript.scrollTop = 40;

    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
    expect(observed).not.toBeNull();
    act(() => {
      const entries = [{ target: observed!, isIntersecting: true } as IntersectionObserverEntry];
      intersectionCallback?.(entries, {} as IntersectionObserver);
      intersectionCallback?.(entries, {} as IntersectionObserver);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    height = 500;
    release();
    await waitFor(() => expect(transcript.scrollTop).toBe(340));
    vi.unstubAllGlobals();
  });

  it("shows an explicit retry only after automatic loading fails", () => {
    const onLoadOlder = vi.fn(async () => false);
    render(
      <Transcript
        messages={[{ role: "user", content: "newest", timestamp: 2 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        hasOlder
        olderError="network unavailable"
        onLoadOlder={onLoadOlder}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry loading earlier messages" }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
