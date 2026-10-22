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

  it.each([undefined, "fetch failed", "This operation was aborted"])(
    "preserves native errors independently of diagnostic text (%j)",
    (errorMessage) => {
      expect(
        assistantOutcome({
          role: "assistant",
          stopReason: "error",
          errorMessage,
        }),
      ).toBe("error");
    },
  );
});
