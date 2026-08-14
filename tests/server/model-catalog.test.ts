import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  availableModelOptions,
  defaultModelOption,
} from "../../server/model-catalog.js";

describe("new-session model catalog", () => {
  it("does not expose Pi's absent-model sentinel as a default", () => {
    expect(
      defaultModelOption({ provider: "unknown", id: "unknown" }),
    ).toBeNull();
  });

  it("projects only browser-safe picker metadata from Pi's available models", async () => {
    const runtime = {
      getAvailable: async () => [
        {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          reasoning: true,
          thinkingLevelMap: {
            minimal: "low",
            xhigh: "high",
            max: null,
            other: "ignored",
          },
          baseUrl: "https://secret.invalid",
          headers: { Authorization: "Bearer secret" },
          api: "anthropic-messages",
        },
      ],
    } as unknown as Pick<ModelRuntime, "getAvailable">;

    await expect(availableModelOptions(runtime)).resolves.toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: true,
        thinkingLevelMap: { minimal: "low", xhigh: "high", max: null },
      },
    ]);
  });
});
