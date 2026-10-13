import { describe, expect, it } from "vitest";
import { stripImageDimensionNotes } from "../../shared/image-dimension-notes";
import {
  sequentialUserTurnAnchors,
  userTurnSummary,
} from "../../shared/user-turns";

const dimensionNote =
  "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";

describe("user-turn projection", () => {
  it("omits Pi dimension suffixes only from image-prompt projections", () => {
    expect(stripImageDimensionNotes(`inspect\n\n${dimensionNote}`, 1)).toBe(
      "inspect",
    );
    expect(
      stripImageDimensionNotes(`\n\n${dimensionNote}\n${dimensionNote}`, 2),
    ).toBe("");
    for (const text of [
      dimensionNote,
      `quoted: ${dimensionNote}`,
      `\n\n${dimensionNote}\nmore user text`,
      `\n\n\`\`\`text\n${dimensionNote}\n\`\`\``,
      "[Image omitted: could not be resized below the inline image size limit.]",
    ]) {
      expect(stripImageDimensionNotes(text, 1)).toBe(text);
    }
    expect(stripImageDimensionNotes(`inspect\n\n${dimensionNote}`, 0)).toBe(
      `inspect\n\n${dimensionNote}`,
    );
    expect(
      userTurnSummary({
        content: [
          { type: "text", text: `\n\n${dimensionNote}` },
          { type: "image" },
        ],
      }),
    ).toEqual({ snippet: "Image attachment", attachmentCount: 1 });
  });

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
