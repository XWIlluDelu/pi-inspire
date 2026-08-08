// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 100 })),
    measureElement: () => undefined,
    scrollToIndex: virtual.scrollToIndex,
  }),
}));

import { Transcript } from "../../src/components/Transcript";

describe("virtualized transcript search navigation", () => {
  it("mounts and follows the virtual tail across the threshold and same-message tool growth", () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 59 ? [] : `settled row ${index}`,
      timestamp: index,
      ...(index === 59 ? { __inspireLiveId: "virtual-tail", __inspireSettled: false } : {}),
    }));
    const props = {
      streaming: true,
      activeAssistantMessageKey: "live:virtual-tail",
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { rerender } = render(<Transcript sessionId="virtual-follow" messages={messages.slice(0, 59)} {...props} />);

    virtual.scrollToIndex.mockClear();
    rerender(<Transcript sessionId="virtual-follow" messages={messages} {...props} />);
    expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(59, { align: "end" });

    virtual.scrollToIndex.mockClear();
    rerender(
      <Transcript
        sessionId="virtual-follow"
        messages={messages.map((message, index) => index === 59 ? {
          ...message,
          content: [
            { type: "thinking", thinking: "continuing reasoning" },
            { type: "toolCall", id: "long-tool", name: "write", arguments: { path: "theory.md" } },
          ],
        } : message)}
        {...props}
      />,
    );
    expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(59, { align: "end" });
  });

  it("navigates by transcript row index and disables pinned latest-follow", () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 45 ? "unique target phrase" : `settled row ${index}`,
      timestamp: index,
    }));
    render(
      <Transcript
        sessionId="large"
        messages={messages}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversation" }), { target: { value: "TARGET" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));

    expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(45, { align: "center" });
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("keeps a prepended search match anchored when a near-bottom scroll precedes a live append", async () => {
    function Harness() {
      const [messages, setMessages] = useState(Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 55 ? "anchored target" : `settled row ${index}`,
        timestamp: index + 10,
      })));
      const [streaming, setStreaming] = useState(false);
      return (
        <>
          <button type="button" onClick={() => {
            setMessages((current) => [
              ...Array.from({ length: 5 }, (_, index) => ({ role: "user", content: `older ${index}`, timestamp: index })),
              ...current,
            ]);
          }}>Prepend older</button>
          <button type="button" onClick={() => {
            setMessages((current) => [...current, {
              role: "assistant",
              content: "live tail",
              timestamp: 999,
              __inspireLiveId: "live-tail",
              __inspireSettled: false,
            }]);
            setStreaming(true);
          }}>Append live</button>
          <Transcript
            sessionId="follow-lock"
            messages={messages}
            streaming={streaming}
            thinkingVisibility="collapsed"
            toolVisibility="collapsed"
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Prepend older" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversation" }), { target: { value: "anchored" } });
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(60, { align: "center" });

    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 10_000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 9_900 },
    });
    fireEvent.scroll(log);
    virtual.scrollToIndex.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Append live" }));

    expect(virtual.scrollToIndex).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 of 1");
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });
});
