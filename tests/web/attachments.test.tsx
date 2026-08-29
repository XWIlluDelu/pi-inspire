// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts";
import { selectAttachmentFiles } from "../../src/attachment-selection";
import { AttachmentList } from "../../src/components/AttachmentList";
import type { PendingAttachment } from "../../src/controllers/composer-controller";
import { store } from "../../src/store";

afterEach(() => cleanup());

describe("attachment presentation", () => {
  it("normalizes a recalled image without a projection incarnation", async () => {
    const originalLoad = store.loadEmbeddedImage;
    const load = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    store.loadEmbeddedImage = load;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:recalled-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
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
        reference: "pi-embedded://4/0",
        preview: true,
      },
    };

    try {
      render(
        <AttachmentList
          sessionId="session-a"
          items={[item]}
          onRemove={() => undefined}
        />,
      );
      await waitFor(() =>
        expect(load).toHaveBeenCalledWith(
          "session-a",
          "history-view",
          "history-view\u0000",
          "pi-embedded://4/0",
          expect.any(AbortSignal),
        ),
      );
    } finally {
      store.loadEmbeddedImage = originalLoad;
    }
  });
});

function file(
  name: string,
  size: number,
  type = "application/octet-stream",
): File {
  return new File([new Uint8Array(size)], name, { type });
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

    expect(
      selectAttachmentFiles(
        [{ size: MAX_PROMPT_IMAGE_BYTES - 1, kind: "image" }],
        [file("over-images.png", 2, "image/png")],
      ),
    ).toMatchObject({
      accepted: [],
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
