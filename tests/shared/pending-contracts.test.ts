import { describe, expect, it } from "vitest";
import {
  pendingContentFromInput,
  projectPendingQueues,
} from "../../server/runtime-pending";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
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
    const pi = {
      steering: Array.from(
        { length: MAX_PENDING_MESSAGES + 1 },
        (_, index) => ({
          text: index ? "" : "first",
          ...(index === MAX_PENDING_MESSAGES ? { imageCount: 2 } : {}),
        }),
      ),
      followUp: [],
    };
    const host = { message: "", behavior: "followUp" as const };
    const merged = projectPendingQueues(pi, [{ ...host, imageCount: 3 }], 0);
    expect(merged).toMatchObject({
      totalCount: MAX_PENDING_MESSAGES + 2,
      totalImageCount: 5,
    });
    expect(merged.steering.every((row) => row.imageCount === undefined)).toBe(
      true,
    );
    expect(parsePendingQueues(merged)).toEqual(merged);
    expect(
      projectPendingQueues(pi, [{ ...host, imageCount: null }], 0)
        .totalImageCount,
    ).toBeUndefined();
  });

  it.each(["Review this report", ""])(
    "projects file references consistently in Pi and Host queues for %j",
    (text) => {
      const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
      const message = text ? `${text}\n\n${trailer}` : trailer;
      const preview = text ? `${text}\n\nreport.csv` : "report.csv";
      const queue = projectPendingQueues(
        { steering: [{ text: message }], followUp: [] },
        [{ message, behavior: "followUp", imageCount: 0 }],
        0,
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

  it("rejects invalid image counts and accepts unknown totals", () => {
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

  it("projects previews and queue counts into the wire format", () => {
    expect(parsePendingMessageSummary(summary)).toEqual(summary);
    const queue = projectPendingQueues(
      { steering: [{ text: "continue" }], followUp: [] },
      [],
      3,
    );
    expect(parsePendingQueues(queue)).toEqual({
      revision: 4,
      totalCount: 1,
      totalImageCount: 0,
      steering: [summary],
      followUp: [],
    });
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
      ends: ["BEGIN", "END"],
    },
    {
      label: "Unicode at the cut boundaries",
      text: `A${"🧭".repeat(300)}Z`,
      ends: ["A", "Z"],
    },
    {
      label: "short text",
      text: "短い🧭\nfull text",
      preview: "短い🧭\nfull text",
    },
  ])(
    "keeps both ends or the whole $label in Pi and Host previews",
    ({ text, preview, ends }) => {
      const merged = projectPendingQueues(
        { steering: [{ text }], followUp: [] },
        [{ message: text, behavior: "followUp", imageCount: 0 }],
        0,
      );
      const summary = merged.steering[0]!;
      expect(summary).toMatchObject({
        textLength: text.length,
        textTruncated: preview !== text,
      });
      if (preview !== undefined) expect(summary.textPreview).toBe(preview);
      else {
        const parts = summary.textPreview.split("\n…\n");
        expect(parts).toHaveLength(2);
        const [head, tail] = parts as [string, string];
        expect(head.startsWith(ends![0]!)).toBe(true);
        expect(tail.endsWith(ends![1]!)).toBe(true);
        expect(text.startsWith(head)).toBe(true);
        expect(text.endsWith(tail)).toBe(true);
        expect(summary.textPreview.length).toBeLessThanOrEqual(
          MAX_PENDING_PREVIEW_CHARS,
        );
        expect(summary.textPreview).not.toMatch(/\p{Surrogate}/u);
      }
      expect(merged.followUp[0]).toMatchObject({
        textPreview: summary.textPreview,
        textLength: summary.textLength,
        textTruncated: summary.textTruncated,
      });
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
    const queue = projectPendingQueues(
      {
        steering: [
          { text: "", imageCount: 2, imageAttachmentIds: ids },
          { text: "" },
        ],
        followUp: [{ text: "caption", imageCount: 1 }],
      },
      [],
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

  it("bounds retained rows while reporting omitted content truthfully", () => {
    const queue = projectPendingQueues(
      pendingContentFromInput({
        steering: Array(MAX_PENDING_MESSAGES + 1).fill("queued input"),
        followUp: ["later"],
      }),
      [],
      0,
    );
    expect(queue.totalCount).toBe(MAX_PENDING_MESSAGES + 2);
    expect(queue.steering).toHaveLength(MAX_PENDING_MESSAGES);
    expect(queue.followUp).toEqual([]);
    expect(parsePendingQueues(queue)).toEqual(queue);
  });
});
