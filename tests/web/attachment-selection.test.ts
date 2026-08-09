import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts";
import { selectAttachmentFiles } from "../../src/attachment-selection";

function file(name: string, size: number, type = "application/octet-stream"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("attachment selection budgets", () => {
  it("accepts candidates in order while enforcing count, file, total, and image limits", () => {
    const oversized = file("oversized.bin", MAX_ATTACHMENT_FILE_BYTES + 1);
    const acceptedFile = file("accepted.bin", 1);
    const fileResult = selectAttachmentFiles([], [oversized, acceptedFile]);
    expect(fileResult.accepted).toEqual([acceptedFile]);
    expect(fileResult.warning).toMatch(/Each attachment/);

    const existing = [{ size: MAX_ATTACHMENT_UPLOAD_BYTES - 1, kind: "file" as const }];
    expect(selectAttachmentFiles(existing, [file("over-total.bin", 2)])).toMatchObject({
      accepted: [],
      warning: expect.stringMatching(/must total/),
    });

    const existingImages = [{ size: MAX_PROMPT_IMAGE_BYTES - 1, kind: "image" as const }];
    expect(selectAttachmentFiles(existingImages, [file("over-images.png", 2, "image/png")])).toMatchObject({
      accepted: [],
      warning: expect.stringMatching(/Images per message/),
    });

    const full = Array.from({ length: MAX_ATTACHMENTS }, () => ({ size: 1, kind: "file" as const }));
    expect(selectAttachmentFiles(full, [file("extra.bin", 1)])).toMatchObject({
      accepted: [],
      warning: expect.stringMatching(/At most/),
    });
  });
});
