// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENTS,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts";
import { selectAttachmentFiles } from "../../src/attachment-selection";
import { clipboardFiles } from "../../src/clipboard-files";
import { AttachmentList } from "../../src/components/AttachmentList";
import type { PendingAttachment } from "../../src/controllers/composer-controller";
import { store } from "../../src/store";

it("reads a recalled image using its original view when the projection incarnation is absent", async () => {
  const load = vi
    .spyOn(store, "loadTranscriptImage")
    .mockResolvedValue(new Blob(["png"]));
  const item: PendingAttachment = {
    localId: "recalled-image",
    fileName: "image.png",
    mimeType: "image/png",
    size: 3,
    kind: "image",
    status: "ready",
    recalledArtifact: {
      type: "image",
      scopeKey: "history-scope",
      viewId: "history-view",
      incarnation: null,
      effectiveLeafId: null,
      reference: "pi-history-image://entry-4/0",
    },
  };

  render(
    <AttachmentList sessionId="session-a" items={[item]} onRemove={() => {}} />,
  );
  expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:test");
  expect(load).toHaveBeenCalledWith(
    "session-a",
    "history-view",
    "history-view\u0000",
    "pi-history-image://entry-4/0",
    expect.any(AbortSignal),
  );
});

function file(
  name: string,
  size: number,
  type = "application/octet-stream",
): File {
  return Object.defineProperty(new File([], name, { type }), "size", {
    value: size,
  });
}

describe("attachment selection budgets", () => {
  it("accepts candidates in order while enforcing count, file, total, and image limits", () => {
    const oversized = file("oversized.bin", MAX_ATTACHMENT_FILE_BYTES + 1);
    const acceptedFile = file("accepted.bin", 1);
    const fileResult = selectAttachmentFiles([], [oversized, acceptedFile]);
    expect(fileResult.accepted).toEqual([acceptedFile]);
    expect(fileResult.warning).toMatch(/Each attachment/);

    expect(
      selectAttachmentFiles(
        [{ size: MAX_ATTACHMENT_UPLOAD_BYTES - 1, kind: "file" }],
        [file("over-total.bin", 2)],
      ),
    ).toMatchObject({
      accepted: [],
      warning: expect.stringMatching(/must total/),
    });

    const ordinary = [
      file("preview.bmp", 2, "image/bmp"),
      file("diagram.svg", 2, "image/svg+xml"),
    ];
    expect(
      selectAttachmentFiles(
        [{ size: MAX_PROMPT_IMAGE_BYTES - 1, kind: "image" }],
        [file("over-images.png", 2, "image/png"), ...ordinary],
      ),
    ).toEqual({
      accepted: ordinary,
      warning: expect.stringMatching(/Images per message/),
    });

    const full = Array.from({ length: MAX_ATTACHMENTS }, () => ({
      size: 1,
      kind: "file" as const,
    }));
    expect(selectAttachmentFiles(full, [file("extra.bin", 1)])).toMatchObject({
      accepted: [],
      warning: expect.stringMatching(/At most/),
    });
  });
});

it("uses one clipboard projection without duplicating one paste or merging distinct files", () => {
  const primary = new File(["png"], "image.png", {
    type: "image/png",
    lastModified: 7,
  });
  const duplicateProjection = new File(["png"], "image.png", {
    type: "image/png",
    lastModified: 8,
  });
  const fallbackItem = {
    kind: "file",
    getAsFile: () => duplicateProjection,
  } as DataTransferItem;
  expect(
    clipboardFiles({
      files: [] as unknown as FileList,
      items: [fallbackItem] as unknown as DataTransferItemList,
    }),
  ).toEqual([duplicateProjection]);
  expect(
    clipboardFiles({
      files: [primary] as unknown as FileList,
      items: [fallbackItem] as unknown as DataTransferItemList,
    }),
  ).toEqual([primary]);

  const sameMetadataA = new File(["one"], "image.png", {
    type: "image/png",
    lastModified: 9,
  });
  const sameMetadataB = new File(["two"], "image.png", {
    type: "image/png",
    lastModified: 9,
  });
  expect(
    clipboardFiles({
      files: [sameMetadataA, sameMetadataB] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    }),
  ).toEqual([sameMetadataA, sameMetadataB]);
});
