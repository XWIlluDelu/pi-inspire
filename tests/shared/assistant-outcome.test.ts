import { describe, expect, it } from "vitest";
import { assistantOutcome } from "../../shared/assistant-outcome.js";

describe("assistant outcomes", () => {
  it.each([
    { role: "assistant", stopReason: "aborted" },
    {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "This operation was aborted",
    },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "  This operation was aborted\n",
    },
  ])(
    "recognizes explicit cancellation without changing its source (%j)",
    (message) => {
      const source = JSON.stringify(message);
      expect(assistantOutcome(message)).toBe("stopped");
      expect(JSON.stringify(message)).toBe(source);
    },
  );

  it.each([
    undefined,
    "This operation was aborted",
    { role: "user", stopReason: "aborted" },
    {
      role: "toolResult",
      stopReason: "error",
      errorMessage: "This operation was aborted",
    },
    {
      role: "assistant",
      stopReason: "stop",
      errorMessage: "This operation was aborted",
    },
    { role: "assistant", stopReason: "length" },
  ])("does not invent an assistant outcome (%j)", (message) => {
    expect(assistantOutcome(message)).toBeNull();
  });

  it.each([
    undefined,
    "",
    "fetch failed",
    "Request timed out: This operation was aborted",
    "This operation was aborted\nProvider connection failed",
    "The server aborted the connection",
  ])("preserves actual or ambiguous errors (%j)", (errorMessage) => {
    expect(
      assistantOutcome({
        role: "assistant",
        stopReason: "error",
        errorMessage,
      }),
    ).toBe("error");
  });
});
