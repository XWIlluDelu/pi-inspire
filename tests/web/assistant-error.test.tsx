// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import {
  type ChatMessage,
  emptyEventSlice,
  reduceEvent,
} from "../../src/events";

function transcript(messages: ChatMessage[], streaming = false) {
  return (
    <Transcript
      sessionId="errors"
      messages={messages}
      streaming={streaming}
      thinkingVisibility="hidden"
      toolVisibility="hidden"
      activityFoldVisibility="collapsed"
    />
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Stopped assistant outcomes", () => {
  it.each(["aborted", "error"])(
    "renders %s cancellation as a stop glyph and label without diagnostics or actions",
    (stopReason) => {
      const cancelled = {
        role: "assistant",
        content: [{ type: "text", text: "Partial response kept before Stop." }],
        stopReason,
        errorMessage: "This operation was aborted",
        timestamp: 2,
      };
      const view = render(transcript([cancelled]));
      const stopped = screen.getByRole("group", { name: "Stopped" });
      expect(stopped).toBeVisible();
      expect(stopped.closest(".response-activity-fold")).toBeNull();
      expect(
        screen.getByText("Partial response kept before Stop."),
      ).toBeVisible();
      expect(screen.queryByRole("group", { name: "Pi error" })).toBeNull();
      expect(stopped).toHaveClass(
        "assistant-error",
        "assistant-error--stopped",
      );
      expect(stopped).toHaveTextContent(/^Stopped$/);
      expect(within(stopped).queryByRole("button")).toBeNull();
      expect(within(stopped).queryByRole("region")).toBeNull();
      const icon = stopped.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("width", "14");
      expect(icon).toHaveAttribute("height", "14");
      expect(icon).toHaveClass("lucide-square");
      expect(icon?.querySelector("circle")).toBeNull();
      expect(icon).toHaveAttribute("fill", "none");
      expect(screen.queryByText("This operation was aborted")).toBeNull();

      const search = screen.getByRole("searchbox", {
        name: "Search conversation",
      });
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
      expect(stopped).toHaveTextContent(/^Stopped$/);
      expect(within(stopped).queryByRole("button")).toBeNull();
      expect(screen.queryByText("This operation was aborted")).toBeNull();
      view.unmount();
      render(transcript(JSON.parse(JSON.stringify([cancelled]))));
      expect(screen.getAllByRole("group", { name: "Stopped" })).toHaveLength(1);
      expect(
        screen.getByText("Partial response kept before Stop."),
      ).toBeVisible();
    },
  );

  it("renders an empty structured cancellation without inventing diagnostic details or Working", () => {
    render(
      transcript([
        { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 },
      ]),
    );
    const stopped = screen.getByRole("group", { name: "Stopped" });
    expect(within(stopped).queryByRole("button")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it.each([
    ["aborted", "This operation was aborted", "aborted"],
    ["error", "This operation was aborted", "aborted"],
    [
      "error",
      "This operation was aborted\nProvider connection failed",
      "failed",
    ],
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

  it("does not turn an actual connection error mentioning abort into Stopped", () => {
    render(
      transcript([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Request timed out: This operation was aborted",
        },
      ]),
    );
    expect(screen.getByRole("group", { name: "Pi error" })).toHaveTextContent(
      "Request timed out",
    );
    expect(screen.queryByRole("group", { name: "Stopped" })).toBeNull();
  });
});

describe("Pi assistant errors", () => {
  it("shows an empty error at its source position even with all activity hidden", () => {
    const { container } = render(
      transcript([
        { role: "user", content: "first prompt", timestamp: 1 },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
          timestamp: 2,
        },
        { role: "assistant", content: "later response", timestamp: 3 },
      ]),
    );
    const rows = [...container.querySelectorAll("[data-transcript-row]")];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("first prompt");
    expect(rows[1]).toHaveTextContent("Pi errorfetch failed");
    expect(rows[2]).toHaveTextContent("later response");
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });

  it("shows one error after all partial response passages and folded activity", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            timestamp: 1,
            stopReason: "error",
            errorMessage: "WebSocket error",
            content: [
              { type: "thinking", thinking: "internal reasoning" },
              { type: "text", text: "first passage" },
              {
                type: "toolCall",
                id: "read",
                name: "read",
                arguments: { path: "file.txt" },
              },
              { type: "text", text: "partial last passage" },
              { type: "thinking", thinking: "last thought" },
            ],
          },
        ]}
        streaming={false}
        thinkingVisibility="expanded"
        toolVisibility="expanded"
        activityFoldVisibility="collapsed"
      />,
    );
    expect(screen.getByText("first passage")).toBeVisible();
    expect(screen.getByText("partial last passage")).toBeVisible();
    const error = screen.getByRole("group", { name: "Pi error" });
    expect(error).toBeVisible();
    expect(error.closest(".response-activity-fold")).toBeNull();
    expect(
      [...container.querySelectorAll("[data-transcript-row]")].at(-1),
    ).toContainElement(error);
  });

  it("renders message_end errors live and once after a history remount", () => {
    const start = reduceEvent(emptyEventSlice(), new Set(), {
      type: "message_start",
      message: { role: "assistant", content: "partial output", timestamp: 2 },
    });
    const view = render(
      transcript(start.slice.messages, start.slice.streaming),
    );
    expect(
      screen.queryByRole("group", { name: "Pi error" }),
    ).not.toBeInTheDocument();
    const end = reduceEvent(start.slice, new Set(), {
      type: "message_end",
      message: {
        role: "assistant",
        content: "partial output",
        timestamp: 2,
        stopReason: "error",
        errorMessage: "terminated",
      },
    });
    view.rerender(transcript(end.slice.messages, end.slice.streaming));
    expect(screen.getByText("partial output")).toBeVisible();
    expect(screen.getByText("terminated")).toBeVisible();
    view.unmount();
    render(transcript(JSON.parse(JSON.stringify(end.slice.messages))));
    expect(screen.getAllByRole("group", { name: "Pi error" })).toHaveLength(1);
    expect(screen.getByText("terminated")).toBeVisible();
  });

  it("expands long plain-text details and copies the full message while collapsed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const text = `fetch failed\n${"diagnostic detail ".repeat(50)}\n<html>not markup</html>`;
    render(
      transcript([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: text,
          timestamp: 1,
        },
      ]),
    );
    const error = screen.getByRole("group", { name: "Pi error" });
    const toggle = within(error).getByRole("button", { name: "Show details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(error).not.toHaveTextContent("not markup");
    fireEvent.click(
      within(error).getByRole("button", { name: "Copy error message" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    expect(
      within(error).getByRole("button", { name: "Error message copied" }),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(error.querySelector(".assistant-error__message")?.textContent).toBe(
      text,
    );
    expect(error.querySelector("html")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Show details");
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

  it("distinguishes empty failures, cancellations and successful messages", () => {
    render(
      transcript([
        { role: "assistant", content: [], stopReason: "error", timestamp: 1 },
        { role: "assistant", content: [], stopReason: "stop", timestamp: 2 },
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "Request aborted",
          timestamp: 3,
        },
      ]),
    );
    expect(screen.getAllByRole("group", { name: "Pi error" })).toHaveLength(1);
    expect(screen.getByText("Pi did not provide error details.")).toBeVisible();
    expect(screen.getByRole("group", { name: "Stopped" })).toBeVisible();
    expect(screen.queryByText("Request aborted")).toBeNull();
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
  const { container, rerender } = render(
    <Transcript
      messages={settled}
      streaming={false}
      thinkingVisibility="dynamic"
      toolVisibility="dynamic"
    />,
  );
  expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(3);
  expect(screen.getAllByRole("group", { name: "Pi error" })).toHaveLength(1);
  expect(container.querySelectorAll(".turn--assistant")).toHaveLength(1);

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
  expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(4);

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
  expect(container.querySelectorAll("[data-transcript-row]")).toHaveLength(4);
  expect(screen.getByText("Working…")).toBeInTheDocument();
});
