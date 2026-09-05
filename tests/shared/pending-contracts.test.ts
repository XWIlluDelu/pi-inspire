import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_MESSAGES,
  parsePendingMessageSummary,
  parsePendingQueues,
} from "../../shared/contracts";
import { pendingQueuesFromTexts } from "../../server/runtime-pending";

const summary = {
  id: "text-steer-0",
  textPreview: "continue",
  textLength: 8,
  textTruncated: false,
};

describe("Pending wire contracts", () => {
  it("uses a bounded text-only decoder without Pi management claims", () => {
    expect(parsePendingMessageSummary(summary)).toEqual(summary);
    const queue = pendingQueuesFromTexts(["continue"], [], 3);
    expect(parsePendingQueues(queue)).toEqual({
      revision: 4,
      totalCount: 1,
      steering: [summary],
      followUp: [],
    });
    expect(queue).not.toHaveProperty("paused");
    expect(queue).not.toHaveProperty("managementAvailable");
  });

  it.each([
    ["an invalid identifier", { ...summary, id: "x".repeat(129) }],
    ["a mismatched truncation marker", { ...summary, textTruncated: true }],
    ["a fractional length", { ...summary, textLength: 8.5 }],
  ])("rejects %s", (_name, value) => {
    expect(parsePendingMessageSummary(value)).toBeNull();
  });

  it("rejects duplicate coordinates and invalid totals", () => {
    const queue = {
      revision: 1,
      totalCount: 2,
      steering: [summary],
      followUp: [summary],
    };
    expect(parsePendingQueues(queue)).toBeNull();
    for (const totalCount of [-1, 0, 0.5, undefined]) {
      expect(
        parsePendingQueues({ ...queue, followUp: [], totalCount }),
      ).toBeNull();
    }
  });

  it("bounds retained rows and text while reporting omitted content truthfully", () => {
    const queue = pendingQueuesFromTexts(
      Array(MAX_PENDING_MESSAGES + 1).fill("x".repeat(600)),
      ["later"],
      0,
    );
    expect(queue.totalCount).toBe(MAX_PENDING_MESSAGES + 2);
    expect(queue.steering).toHaveLength(MAX_PENDING_MESSAGES);
    expect(queue.followUp).toEqual([]);
    expect(queue.steering[0]).toMatchObject({
      textPreview: "x".repeat(512),
      textLength: 600,
      textTruncated: true,
    });
    expect(parsePendingQueues(queue)).toEqual(queue);
  });
});
