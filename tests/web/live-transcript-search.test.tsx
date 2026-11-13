// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Transcript } from "../../src/components/Transcript";
import { openTranscriptSearch } from "./helpers";

describe("Live transcript search navigation", () => {
  it("clears view-local search when the branch projection changes", () => {
    const props = {
      sessionId: "branch-session",
      messages: [{ role: "assistant", content: "branch answer", timestamp: 1 }],
      streaming: false,
      thinkingVisibility: "collapsed" as const,
      toolVisibility: "collapsed" as const,
    };
    const { rerender } = render(<Transcript {...props} viewId="branch-a" />);
    const search = openTranscriptSearch();
    fireEvent.change(search, { target: { value: "answer" } });
    expect(search).toHaveValue("answer");

    rerender(<Transcript {...props} viewId="branch-b" />);
    expect(search).toHaveValue("");
  });

  it("follows the Live tail when the same message grows", () => {
    const prompt = { role: "user", content: "Latest prompt", timestamp: 1 };
    const live = {
      role: "assistant",
      timestamp: 2,
      __inspireLiveId: "tail",
      __inspireSettled: false,
      content: [],
    };
    const props = {
      streaming: true,
      activeAssistantMessageKey: "live:tail",
      thinkingVisibility: "dynamic" as const,
      toolVisibility: "dynamic" as const,
    };
    const { rerender } = render(
      <Transcript sessionId="follow" messages={[prompt]} {...props} />,
    );

    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 6_100 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 5_600 },
    });
    rerender(
      <Transcript sessionId="follow" messages={[prompt, live]} {...props} />,
    );
    expect(log.scrollTop).toBe(5_700);
    expect(
      screen.getByText("Working…").closest(".assistant-activity"),
    ).toHaveAttribute("role", "status");

    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 6_300,
    });
    rerender(
      <Transcript
        sessionId="follow"
        messages={[
          prompt,
          {
            ...live,
            content: [
              { type: "thinking", thinking: "continuing reasoning" },
              {
                type: "toolCall",
                id: "long-tool",
                name: "write",
                arguments: { path: "theory.md" },
              },
            ],
          },
        ]}
        {...props}
      />,
    );
    expect(log.scrollTop).toBe(5_900);
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });

  it("keeps a search match selected when a near-bottom scroll precedes a live append", async () => {
    function Harness() {
      const [messages, setMessages] = useState([
        { role: "user", content: "anchored target", timestamp: 1 },
        { role: "assistant", content: "settled reply", timestamp: 2 },
      ]);
      const [streaming, setStreaming] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setMessages((current) => [
                ...current,
                {
                  role: "assistant",
                  content: "live tail",
                  timestamp: 999,
                  __inspireLiveId: "live-tail",
                  __inspireSettled: false,
                },
              ]);
              setStreaming(true);
            }}
          >
            Append live
          </button>
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
    fireEvent.change(openTranscriptSearch(), { target: { value: "anchored" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Next transcript match" }),
    );
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 10_000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 9_900 },
    });
    fireEvent.scroll(log);
    fireEvent.click(screen.getByRole("button", { name: "Append live" }));

    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 1");
    expect(log.scrollTop).toBe(9_900);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });
});
