// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantOutcome } from "../../shared/assistant-outcome";
import { AppErrorBoundary } from "../../src/components/AppErrorBoundary";
import { Transcript } from "../../src/components/Transcript";

describe("Stopped assistant outcomes", () => {
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
      screen.getByRole("button", { name: "Refresh page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("private render detail")).not.toBeInTheDocument();
  });
});
