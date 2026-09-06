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
      assistantRoundDisplay="divider"
    />
  );
}

afterEach(() => vi.restoreAllMocks());

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
    expect(rows[1]).toHaveTextContent("PI errorfetch failed");
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
        assistantRoundDisplay="divider"
      />,
    );
    expect(screen.getByText("first passage")).toBeVisible();
    expect(screen.getByText("partial last passage")).toBeVisible();
    const error = screen.getByRole("group", { name: "PI error" });
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
      screen.queryByRole("group", { name: "PI error" }),
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
    expect(screen.getAllByRole("group", { name: "PI error" })).toHaveLength(1);
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
    const error = screen.getByRole("group", { name: "PI error" });
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

  it("keeps missing error details visible without interpreting unrelated stop reasons", () => {
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
    expect(screen.getAllByRole("group", { name: "PI error" })).toHaveLength(1);
    expect(screen.getByText("PI did not provide error details.")).toBeVisible();
    expect(screen.queryByText("Request aborted")).not.toBeInTheDocument();
  });
});
