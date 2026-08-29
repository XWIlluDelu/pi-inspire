import { describe, expect, it } from "vitest";
import {
  sequentialUserTurnAnchors,
  userTurnSummary,
} from "../../shared/user-turns";

describe("user-turn projection", () => {
  it("shares bounded text and image summaries across projections", () => {
    expect(
      userTurnSummary({
        content: [
          { type: "text", text: "  inspect\nthis  " },
          { type: "image", data: "first" },
          { type: "image", data: "second" },
        ],
      }),
    ).toEqual({ snippet: "inspect this", attachmentCount: 2 });
    expect(
      userTurnSummary({
        content: [
          { type: "image", data: "first" },
          { type: "image", data: "second" },
        ],
      }),
    ).toEqual({ snippet: "2 image attachments", attachmentCount: 2 });
    expect(
      Array.from(userTurnSummary({ content: "😀".repeat(181) }).snippet),
    ).toHaveLength(180);
  });

  it("assigns sequential ordinals without trusting stale projected values", () => {
    expect(
      sequentialUserTurnAnchors(
        [
          { role: "assistant", content: "skip" },
          {
            role: "user",
            __inspireMessageId: "known",
            __inspireUserTurnIndex: 99,
            content: "first",
          },
          { role: "user", content: [{ type: "image", data: "image" }] },
        ],
        "fallback",
      ),
    ).toEqual([
      {
        id: "known",
        ordinal: 0,
        snippet: "first",
        attachmentCount: 0,
      },
      {
        id: "fallback:2",
        ordinal: 1,
        snippet: "Image attachment",
        attachmentCount: 1,
      },
    ]);
  });
});
