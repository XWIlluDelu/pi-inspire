import { describe, expect, it } from "vitest";
import {
  parsePendingMessageSummary,
  parsePendingQueues,
} from "../../shared/contracts";

const summary = {
  id: "pending-1",
  textPreview: "continue",
  textLength: 8,
  textTruncated: false,
  imageCount: 0,
  nonTextContentCount: 0,
};

describe("Pending wire contracts", () => {
  it("uses the same bounded message decoder for queue envelopes", () => {
    expect(parsePendingMessageSummary(summary)).toEqual(summary);
    expect(
      parsePendingQueues({
        managementAvailable: true,
        paused: false,
        revision: 4,
        steering: [summary],
        followUp: [{ ...summary, id: "pending-2" }],
      }),
    ).toEqual({
      managementAvailable: true,
      paused: false,
      revision: 4,
      steering: [summary],
      followUp: [{ ...summary, id: "pending-2" }],
    });
  });

  it.each([
    ["an invalid identifier", { ...summary, id: "x".repeat(129) }],
    ["a mismatched truncation marker", { ...summary, textTruncated: true }],
    ["a fractional count", { ...summary, imageCount: 0.5 }],
  ])("rejects %s", (_name, value) => {
    expect(parsePendingMessageSummary(value)).toBeNull();
  });

  it.each([
    [
      "duplicate IDs across queue kinds",
      {
        managementAvailable: true,
        paused: false,
        revision: 4,
        steering: [summary],
        followUp: [summary],
      },
    ],
    [
      "a paused queue without negotiated management",
      {
        managementAvailable: false,
        paused: true,
        revision: 4,
        steering: [],
        followUp: [],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parsePendingQueues(value)).toBeNull();
  });
});
