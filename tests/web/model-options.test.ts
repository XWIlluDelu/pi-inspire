import { describe, expect, it } from "vitest";
import { supportedThinkingLevels } from "../../src/model-options";

describe("new-session thinking choices", () => {
  it("mirrors Pi's metadata rules for ordinary, extended, and unsupported reasoning", () => {
    expect(supportedThinkingLevels(null)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      supportedThinkingLevels({ provider: "p", id: "plain", reasoning: false }),
    ).toEqual(["off"]);
    expect(
      supportedThinkingLevels({
        provider: "p",
        id: "reasoning",
        reasoning: true,
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(
      supportedThinkingLevels({
        provider: "p",
        id: "mapped",
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: "high", max: "high" },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});
