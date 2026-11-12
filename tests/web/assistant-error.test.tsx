// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantOutcome } from "../../shared/assistant-outcome";
import { AppErrorBoundary } from "../../src/components/AppErrorBoundary";
import { Transcript } from "../../src/components/Transcript";
import {
  type ChatMessage,
  emptyEventSlice,
  reduceEvent,
} from "../../src/events";
import { openTranscriptSearch } from "./helpers";

function transcript(messages: ChatMessage[], streaming = false) {
  return (
    <Transcript
      sessionId="errors"
      messages={messages}
      streaming={streaming}
      thinkingVisibility="expanded"
      toolVisibility="hidden"
      activityFoldVisibility="collapsed"
    />
  );
}

describe("Stopped assistant outcomes", () => {
  it("searches the visible Stopped label while excluding hidden cancellation diagnostics", () => {
    render(
      transcript([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Partial response kept before Stop." },
          ],
          stopReason: "aborted",
          errorMessage: "This operation was aborted",
        },
      ]),
    );
    const search = openTranscriptSearch();
    fireEvent.change(search, {
      target: { value: "This operation was aborted" },
    });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("0 matches");
    fireEvent.change(search, { target: { value: "Stopped" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 1");
    expect(screen.getByRole("group", { name: "Stopped" })).toBeVisible();
  });

  it.each([
    ["aborted", "This operation was aborted", "aborted"],
    ["error", "This operation was aborted", "failed"],
  ])(
    "reduces %s / %s to its true terminal state before settlement",
    (stopReason, errorMessage, outcome) => {
      const start = reduceEvent(emptyEventSlice(), new Set(), {
        type: "agent_start",
      });
      const source = {
        role: "assistant",
        content: [],
        stopReason,
        errorMessage,
        timestamp: 2,
      };
      const end = reduceEvent(start.slice, new Set(), {
        type: "message_end",
        message: source,
      });
      expect(end.slice.runState).toBe(outcome);
      expect(end.slice.streaming).toBe(false);
      expect(end.slice.messages[0]).toMatchObject(source);
      const settled = reduceEvent(end.slice, new Set(), {
        type: "agent_settled",
      });
      expect(settled.slice.runState).toBe(outcome);
    },
  );

  it("only assigns an outcome to a terminal assistant record", () => {
    expect(
      assistantOutcome({ role: "toolResult", stopReason: "error" }),
    ).toBeNull();
    expect(
      assistantOutcome({
        role: "assistant",
        stopReason: "stop",
        errorMessage: "This operation was aborted",
      }),
    ).toBeNull();
    expect(assistantOutcome("This operation was aborted")).toBeNull();
  });
});

describe("Pi assistant errors", () => {
  it("keeps failures in transcript order outside closed activity", () => {
    render(
      <Transcript
        messages={[
          { role: "user", content: "first prompt", timestamp: 1 },
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "empty failure",
            timestamp: 2,
          },
          {
            role: "assistant",
            timestamp: 3,
            stopReason: "error",
            errorMessage: "partial failure",
            content: [
              { type: "text", text: "first passage" },
              {
                type: "toolCall",
                id: "read",
                name: "read",
                arguments: { path: "file.txt" },
              },
              { type: "text", text: "last partial passage" },
              { type: "thinking", thinking: "last thought" },
            ],
          },
          { role: "assistant", content: "later response", timestamp: 4 },
        ]}
        streaming={false}
        thinkingVisibility="expanded"
        toolVisibility="expanded"
        activityFoldVisibility="collapsed"
      />,
    );
    const [empty, partial] = screen.getAllByRole("group", { name: "Pi error" });
    expect(empty).toHaveTextContent("empty failure");
    expect(partial).toHaveTextContent("partial failure");
    const ordered = [
      screen.getByText("first prompt"),
      empty!,
      screen.getByText("first passage"),
      screen.getByText("last partial passage"),
      partial!,
      screen.getByText("later response"),
    ];
    for (const [index, row] of ordered.slice(1).entries())
      expect(
        ordered[index]!.compareDocumentPosition(row) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Expand assistant activity" })
        .length,
    ).toBeGreaterThan(0);
    expect(partial).toBeVisible();
  });

  it("keeps a complete reason paragraph readable without trailing ellipsis, with diagnostics on demand", () => {
    const reason = "fetch failed\nThe provider closed the connection.";
    render(
      transcript([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage:
            reason + "\n\nDiagnostic line: provider connection reset",
        },
      ]),
    );
    const error = screen.getByRole("group", { name: "Pi error" });
    expect(error.querySelector(".assistant-error__message")?.textContent).toBe(
      reason,
    );
    expect(error).not.toHaveTextContent("Diagnostic line");
    fireEvent.click(
      within(error).getByRole("button", { name: "Show details" }),
    );
    expect(error).toHaveTextContent(
      "Diagnostic line: provider connection reset",
    );
  });

  it("offers details for many short lines, but no disclosure for a short error", () => {
    render(
      transcript([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "a\nb\nc\nd\ne\nf",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
          timestamp: 2,
        },
      ]),
    );
    expect(
      screen.getAllByRole("button", { name: "Show details" }),
    ).toHaveLength(1);
    expect(screen.getByText("fetch failed")).toBeVisible();
  });
});

it("shows settled empty Pi errors without treating them as the active empty call", () => {
  const settled = [
    { role: "user", content: "question", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "recovered answer" }],
      timestamp: 3,
    },
  ];
  const { rerender } = render(
    <Transcript
      messages={settled}
      streaming={false}
      thinkingVisibility="dynamic"
      toolVisibility="dynamic"
    />,
  );
  expect(screen.getByRole("group", { name: "Pi error" })).toHaveTextContent(
    "Pi did not provide error details.",
  );

  const settledRetry = {
    role: "assistant",
    content: [],
    stopReason: "error",
    timestamp: 4,
    __inspireLiveId: "settled-retry",
    __inspireSettled: true,
  };
  rerender(
    <Transcript
      messages={[...settled, settledRetry]}
      streaming
      activeAssistantMessageKey="live:settled-retry"
      thinkingVisibility="dynamic"
      toolVisibility="dynamic"
    />,
  );
  expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  expect(screen.getAllByRole("group", { name: "Pi error" })).toHaveLength(2);

  const activeRetry = {
    role: "assistant",
    content: [],
    timestamp: 5,
    __inspireLiveId: "retry-call",
  };
  rerender(
    <Transcript
      messages={[...settled, activeRetry]}
      streaming
      activeAssistantMessageKey="live:retry-call"
      thinkingVisibility="dynamic"
      toolVisibility="dynamic"
    />,
  );
  expect(screen.getByText("Working…")).toBeInTheDocument();
});

describe("AppErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces a render crash with a privacy-safe recovery surface", () => {
    function BrokenView(): never {
      throw new Error("private render detail");
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "The workbench hit an error" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("private render detail")).not.toBeInTheDocument();
  });
});
