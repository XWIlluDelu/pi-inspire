import { describe, expect, it } from "vitest";
import { summarizeActivityText } from "../../src/components/transcript-fold";

describe("summarizeActivityText", () => {
  it("names steps, distinct tools with repeats, and failures", () => {
    expect(
      summarizeActivityText([
        { id: "1", kind: "thinking" },
        { id: "2", kind: "tool", name: "read" },
        { id: "3", kind: "tool", name: "read" },
        { id: "4", kind: "tool", name: "bash", failed: true },
      ]),
    ).toEqual({
      steps: "4 steps",
      tools: "thinking · read ×2 · bash",
      failed: 1,
    });
  });

  it("caps the tool list and counts deferred presence without naming it", () => {
    expect(
      summarizeActivityText([
        { id: "d", kind: "tool", deferred: true },
        { id: "1", kind: "tool", name: "read" },
        { id: "2", kind: "tool", name: "edit" },
        { id: "3", kind: "tool", name: "grep" },
        { id: "4", kind: "tool", name: "bash" },
      ]),
    ).toEqual({ steps: "5 steps", tools: "read · edit · grep +1", failed: 0 });
    expect(summarizeActivityText([])).toEqual({
      steps: "",
      tools: "",
      failed: 0,
    });
    expect(summarizeActivityText([{ id: "t", kind: "thinking" }]).steps).toBe(
      "1 step",
    );
  });
});
