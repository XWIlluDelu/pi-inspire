// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";

describe("Transcript older-page anchor", () => {
  it("preserves an unpinned visible anchor when a retained history receives a live append", () => {
    const base = [
      {
        role: "user",
        content: "old",
        timestamp: 1,
        __inspireMessageId: "m1:0",
      },
      {
        role: "assistant",
        content: "new",
        timestamp: 2,
        __inspireMessageId: "m2:0",
      },
    ];
    const { container, rerender } = render(
      <Transcript
        messages={base}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      value: 300,
    });
    transcript.scrollTop = 200;
    fireEvent.wheel(transcript, { deltaY: -200 });
    fireEvent.scroll(transcript);
    rerender(
      <Transcript
        messages={[
          ...base,
          {
            role: "assistant",
            content: "append",
            timestamp: 3,
            __inspireMessageId: "m3:0",
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(transcript.scrollTop).toBe(200);
  });

  it("loads near the top without a button and preserves the visible anchor", async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    let height = 1_000;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const onLoadOlder = vi.fn(async () => {
      await loading;
      return true;
    });
    const messages = [{ role: "user", content: "newest", timestamp: 2 }];
    const renderTranscript = (hasOlder: boolean) => (
      <Transcript
        messages={messages}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        hasOlder={hasOlder}
        onLoadOlder={onLoadOlder}
      />
    );
    const { container, rerender } = render(renderTranscript(false));
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 400;
    fireEvent.wheel(transcript, { deltaY: -200 });
    fireEvent.scroll(transcript); // leave latest-follow before paging becomes available
    rerender(renderTranscript(true));
    expect(onLoadOlder).not.toHaveBeenCalled();

    transcript.scrollTop = 40;
    expect(
      screen.queryByRole("button", { name: "Load older messages" }),
    ).not.toBeInTheDocument();
    act(() => {
      fireEvent.scroll(transcript);
      fireEvent.scroll(transcript);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    height = 1_300;
    release();
    await waitFor(() => expect(transcript.scrollTop).toBe(340));
    vi.unstubAllGlobals();
  });

  it("loads another page when the user returns to the near-top boundary", async () => {
    let height = 1_000;
    let calls = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    function Harness({ enabled }: { enabled: boolean }) {
      const [messages, setMessages] = useState([
        { role: "user", content: "newest", timestamp: 3 },
      ]);
      const [remaining, setRemaining] = useState(2);
      const [loading, setLoading] = useState(false);
      const loadOlder = async () => {
        setLoading(true);
        await Promise.resolve();
        calls += 1;
        height += 1_000;
        setMessages((current) => [
          {
            role: "user",
            content: `older page ${calls}`,
            timestamp: 3 - calls,
          },
          ...current,
        ]);
        setRemaining((current) => current - 1);
        setLoading(false);
        return true;
      };
      return (
        <Transcript
          messages={messages}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
          hasOlder={enabled && remaining > 0}
          loadingOlder={loading}
          onLoadOlder={loadOlder}
        />
      );
    }

    const { container, rerender } = render(<Harness enabled={false} />);
    const transcript = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 400;
    fireEvent.wheel(transcript, { deltaY: -200 });
    fireEvent.scroll(transcript);
    rerender(<Harness enabled />);

    transcript.scrollTop = 40;
    fireEvent.scroll(transcript);
    await waitFor(() => expect(calls).toBe(1));
    expect(transcript.scrollTop).toBe(1_040);

    transcript.scrollTop = 40;
    fireEvent.scroll(transcript);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText("older page 2")).toBeInTheDocument();
    expect(
      screen.queryByText("Loading earlier messages…"),
    ).not.toBeInTheDocument();

    transcript.scrollTop = 40;
    fireEvent.scroll(transcript);
    expect(calls).toBe(2);
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

    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading earlier messages" }),
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
