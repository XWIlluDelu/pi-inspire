// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import { deferred } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("pauses automatic paging after failure and resumes only through an explicit retry", async () => {
    const firstPage = deferred<boolean>();
    const retryPage = deferred<boolean>();
    const request = vi
      .fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(retryPage.promise);

    function Harness() {
      const [error, setError] = useState<string | null>(null);
      const [hasOlder, setHasOlder] = useState(true);
      const [messages, setMessages] = useState([
        { role: "user", content: "newest", timestamp: 2 },
      ]);
      const loadOlder = async () => {
        const loaded = await request();
        if (loaded) {
          setError(null);
          setHasOlder(false);
          setMessages((current) => [
            { role: "user", content: "retried older page", timestamp: 1 },
            ...current,
          ]);
        } else setError("network unavailable");
        return loaded;
      };
      return (
        <Transcript
          messages={messages}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
          hasOlder={hasOlder}
          olderError={error}
          onLoadOlder={loadOlder}
        />
      );
    }

    render(<Harness />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry loading earlier messages" }),
    ).toBeNull();

    await act(async () => firstPage.resolve(false));
    const retry = screen.getByRole("button", {
      name: "Retry loading earlier messages",
    });
    expect(retry).toHaveAttribute("title", "network unavailable");
    expect(screen.queryByText("Loading earlier messages…")).toBeNull();
    const log = screen.getByRole("log");
    fireEvent.wheel(log, { deltaY: -200 });
    fireEvent.scroll(log);
    fireEvent.scroll(log);
    expect(request).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry loading earlier messages" }),
    ).toBeNull();
    await act(async () => retryPage.resolve(true));
    await screen.findByText("retried older page");
    expect(
      screen.queryByRole("button", { name: "Retry loading earlier messages" }),
    ).toBeNull();
    expect(screen.queryByText("Loading earlier messages…")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

it("follows thinking and tool growth until the user deliberately scrolls away", () => {
  vi.useFakeTimers();
  const observed = new Map<Element, ResizeObserverCallback>();
  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      observed.set(target, this.callback);
    }
    unobserve(target: Element) {
      observed.delete(target);
    }
    disconnect() {
      observed.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  const active = {
    role: "assistant",
    timestamp: 2,
    __inspireLiveId: "growing-call",
    content: [] as Array<Record<string, unknown>>,
  };
  const props = {
    streaming: true,
    activeAssistantMessageKey: "live:growing-call",
    thinkingVisibility: "dynamic" as const,
    toolVisibility: "dynamic" as const,
  };
  const { container, rerender } = render(
    <Transcript
      messages={[{ role: "user", content: "question", timestamp: 1 }, active]}
      {...props}
    />,
  );
  const log = screen.getByRole("log");
  expect(
    screen.getByText("Working…").closest(".assistant-activity"),
  ).toHaveAttribute("role", "status");
  let scrollHeight = 1_000;
  Object.defineProperties(log, {
    clientHeight: { configurable: true, get: () => 300 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, writable: true, value: 700 },
  });

  rerender(
    <Transcript
      messages={[
        { role: "user", content: "question", timestamp: 1 },
        {
          ...active,
          content: [
            { type: "thinking", thinking: "live reasoning" },
            {
              type: "toolCall",
              id: "live-tool",
              name: "read",
              arguments: { path: "notes.md" },
            },
          ],
        },
      ]}
      {...props}
    />,
  );
  expect(log.scrollTop).toBe(700);
  expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  expect(container.querySelector(".card--thinking")).not.toBeNull();
  expect(container.querySelector(".card--tool")).not.toBeNull();

  // A delayed Markdown/card/virtual-row measurement must not turn the
  // programmatic follow scroll into apparent user intent.
  scrollHeight = 1_400;
  fireEvent.scroll(log);
  expect(
    screen.queryByRole("button", { name: "Jump to latest" }),
  ).not.toBeInTheDocument();
  const content = container.querySelector(".transcript__content")!;
  act(() => observed.get(content)?.([], {} as ResizeObserver));
  expect(log.scrollTop).toBe(1_100);
  fireEvent.scroll(log);

  // Input precedes its scroll event. A stream delta in that gap must not win
  // the race and pull the viewport back to latest.
  fireEvent.wheel(log, { deltaY: -200 });
  scrollHeight = 1_450;
  rerender(
    <Transcript
      messages={[
        { role: "user", content: "question", timestamp: 1 },
        {
          ...active,
          content: [
            { type: "thinking", thinking: "live reasoning continues" },
            {
              type: "toolCall",
              id: "live-tool",
              name: "read",
              arguments: { path: "notes.md" },
            },
          ],
        },
      ]}
      {...props}
    />,
  );
  expect(log.scrollTop).toBe(1_100);

  // Even a small deliberate move inside the old 80px proximity band owns the
  // viewport. Later layout-driven scroll events must not silently reacquire
  // latest-follow after the input marker expires.
  log.scrollTop = 1_090;
  fireEvent.scroll(log);
  expect(
    screen.getByRole("button", { name: "Jump to latest" }),
  ).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(401));
  log.scrollTop = 1_120;
  fireEvent.scroll(log);
  scrollHeight = 1_700;
  act(() => observed.get(content)?.([], {} as ResizeObserver));
  expect(log.scrollTop).toBe(1_120);
  expect(
    screen.getByRole("button", { name: "Jump to latest" }),
  ).toBeInTheDocument();
});
