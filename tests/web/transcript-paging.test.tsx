// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("preserves the visible scroll anchor when older rows are prepended", async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    let height = 200;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { container } = render(
      <Transcript
        messages={[{ role: "user", content: "newest", timestamp: 2 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        hasOlder
        onLoadOlder={() => loading}
      />,
    );
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => height });
    transcript.scrollTop = 40;

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    height = 500;
    release();
    await waitFor(() => expect(transcript.scrollTop).toBe(340));
    vi.unstubAllGlobals();
  });
});
