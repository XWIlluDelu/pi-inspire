import { describe, expect, it } from "vitest";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import {
  mergePendingQueues,
  pendingQueuesFromContent,
  pendingQueuesFromTexts,
} from "../../server/runtime-pending";
import {
  MAX_PENDING_MESSAGES,
  parsePendingMessageSummary,
  parsePendingQueues,
} from "../../shared/contracts";

const summary = {
  id: "text-steer-0",
  textPreview: "continue",
  textLength: 8,
  textTruncated: false,
};

describe("Pending wire contracts", () => {
  it("counts image formats across omitted rows and Host-held input without exposing image data", () => {
    const pi = pendingQueuesFromContent(
      {
        steering: Array.from(
          { length: MAX_PENDING_MESSAGES + 1 },
          (_, index) => ({
            text: index ? "" : "first",
            ...(index === MAX_PENDING_MESSAGES ? { imageCount: 2 } : {}),
          }),
        ),
        followUp: [],
      },
      0,
    );
    const merged = mergePendingQueues(
      pi,
      [{ message: "", behavior: "followUp", imageCount: 3 }],
      pi.revision,
    );
    expect(merged).toMatchObject({
      totalCount: MAX_PENDING_MESSAGES + 2,
      totalImageCount: 5,
    });
    expect(merged.steering.every((row) => row.imageCount === undefined)).toBe(
      true,
    );
    expect(parsePendingQueues(merged)).toEqual(merged);
    expect(
      mergePendingQueues(pi, [{ message: "", imageCount: null }], 0)
        .totalImageCount,
    ).toBeUndefined();
  });

  it.each(["Review this report", ""])(
    "projects file references consistently in Pi and Host queues for %j",
    (text) => {
      const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
      const message = text ? `${text}\n\n${trailer}` : trailer;
      const preview = text ? `${text}\n\nreport.csv` : "report.csv";
      const pi = pendingQueuesFromTexts([message], [], 0);
      const queue = mergePendingQueues(
        pi,
        [{ message, behavior: "followUp" }],
        pi.revision,
      );
      const expected = {
        textPreview: preview,
        textLength: preview.length,
        textTruncated: false,
      };
      expect(queue.steering[0]).toMatchObject(expected);
      expect(queue.followUp[0]).toMatchObject(expected);
      expect(parsePendingQueues(queue)).toEqual(queue);
    },
  );

  it("rejects invalid format counts without requiring new metadata from older Hosts", () => {
    const base = {
      revision: 1,
      totalCount: 1,
      steering: [{ ...summary, imageCount: 2 }],
      followUp: [],
    };
    for (const totalImageCount of [-1, 1.5, "2", 1])
      expect(parsePendingQueues({ ...base, totalImageCount })).toBeNull();
    expect(parsePendingQueues({ ...base, totalImageCount: 2 })).not.toBeNull();
    expect(parsePendingQueues(base)).not.toBeNull();
  });

  it("uses bounded previews without Pi management claims", () => {
    expect(parsePendingMessageSummary(summary)).toEqual(summary);
    const queue = pendingQueuesFromTexts(["continue"], [], 3);
    expect(parsePendingQueues(queue)).toEqual({
      revision: 4,
      totalCount: 1,
      totalImageCount: 0,
      steering: [summary],
      followUp: [],
    });
    expect(queue).not.toHaveProperty("paused");
    expect(queue).not.toHaveProperty("managementAvailable");
  });

  it.each([
    {
      label: "multiline input",
      text: "first line\nsecond line\nthird line\nhidden middle\nfinal line\n",
      preview: "first line\nsecond line\nthird line\n…\nfinal line",
    },
    {
      label: "one long line",
      text: `BEGIN${"x".repeat(600)}END`,
      preview: `BEGIN${"x".repeat(379)}\n…\n${"x".repeat(122)}END`,
    },
    {
      label: "Unicode at the cut boundaries",
      text: `A${"🧭".repeat(300)}Z`,
      preview: `A${"🧭".repeat(191)}\n…\n${"🧭".repeat(62)}Z`,
    },
    {
      label: "short text",
      text: "短い🧭\nfull text",
      preview: "短い🧭\nfull text",
    },
  ])(
    "keeps both ends or the whole $label in Pi and Host previews",
    ({ text, preview }) => {
      const pi = pendingQueuesFromTexts([text], [], 0);
      const merged = mergePendingQueues(
        pi,
        [{ message: text, behavior: "followUp" }],
        pi.revision,
      );
      const fields = {
        textPreview: preview,
        textLength: text.length,
        textTruncated: preview !== text,
      };
      expect(merged.steering[0]).toMatchObject(fields);
      expect(merged.followUp[0]).toMatchObject(fields);
      expect(parsePendingQueues(merged)).toEqual(merged);
    },
  );

  it.each([
    ["an invalid identifier", { ...summary, id: "x".repeat(129) }],
    ["a mismatched truncation marker", { ...summary, textTruncated: true }],
    ["a fractional length", { ...summary, textLength: 8.5 }],
    ["a zero image count", { ...summary, imageCount: 0 }],
    ["a fractional image count", { ...summary, imageCount: 1.5 }],
    ["a nonnumeric image count", { ...summary, imageCount: "2" }],
    [
      "image bodies in place of handles",
      {
        ...summary,
        imageCount: 1,
        imageAttachmentIds: ["data:image/png;base64,AAAA"],
      },
    ],
    [
      "image handles without a matching count",
      {
        ...summary,
        imageCount: 2,
        imageAttachmentIds: ["12345678-1234-1234-1234-123456789012"],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parsePendingMessageSummary(value)).toBeNull();
  });

  it("preserves known image handles without labeling unknown empty rows or embedding bytes", () => {
    const ids = [
      "12345678-1234-1234-1234-123456789012",
      "12345678-1234-1234-1234-123456789013",
    ];
    const queue = pendingQueuesFromContent(
      {
        steering: [
          { text: "", imageCount: 2, imageAttachmentIds: ids },
          { text: "" },
        ],
        followUp: [{ text: "caption", imageCount: 1 }],
      },
      0,
    );
    expect(parsePendingQueues(queue)).toEqual(queue);
    expect(queue.steering[0]).toMatchObject({
      textPreview: "",
      textLength: 0,
      imageCount: 2,
      imageAttachmentIds: ids,
    });
    expect(queue.steering[1]).not.toHaveProperty("imageCount");
    expect(queue.steering[1]).not.toHaveProperty("imageAttachmentIds");
    expect(queue.followUp[0]).toMatchObject({
      textPreview: "caption",
      imageCount: 1,
    });
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
      textPreview: `${"x".repeat(384)}\n…\n${"x".repeat(125)}`,
      textLength: 600,
      textTruncated: true,
    });
    expect(parsePendingQueues(queue)).toEqual(queue);
  });
});
