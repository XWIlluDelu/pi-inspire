// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENTS,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts";
import { selectAttachmentFiles } from "../../src/attachment-selection";
import { clipboardFiles } from "../../src/clipboard-files";
import { AttachmentList } from "../../src/components/AttachmentList";
import { Transcript } from "../../src/components/Transcript";
import type { PendingAttachment } from "../../src/controllers/composer-controller";
import { store } from "../../src/store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("attachment presentation", () => {
  it.each([
    ["measurements.csv", "file-spreadsheet"],
    ["config.json", "file-braces-corner"],
    ["analysis.py", "file-code-corner"],
    ["bundle.zip", "file-archive"],
    ["recording.wav", "file-headphone"],
    ["demo.webm", "file-play"],
    ["diagram.svg", "file-image"],
    ["report.pdf", "file-text"],
    ["notes.md", "file-text"],
    ["sample.unknown", "file-text"],
  ])(
    "keeps %s in the same file-icon family before and after sending",
    async (fileName, icon) => {
      render(
        <>
          <AttachmentList
            sessionId="s"
            items={[
              {
                localId: "attachment",
                fileName,
                mimeType: "application/octet-stream",
                size: 42,
                kind: "file",
                status: "ready",
              },
            ]}
            onRemove={() => {}}
          />
          <Transcript
            sessionId="s"
            messages={[
              {
                role: "user",
                content: `Referenced files available to the agent (JSON paths):\n- "/workspace/${fileName}"`,
              },
            ]}
            streaming={false}
            thinkingVisibility="collapsed"
            toolVisibility="collapsed"
          />
        </>,
      );
      const sent = await screen.findByRole("list", {
        name: "Referenced files",
      });
      const staged = screen.getByRole("list", { name: "Attachments" });
      for (const list of [staged, sent]) {
        const iconElement = list.querySelector(`svg.lucide-${icon}`);
        expect(iconElement).not.toBeNull();
        expect(iconElement).toHaveAttribute("aria-hidden", "true");
        expect(iconElement).toHaveAttribute("width", "13");
        expect(iconElement).toHaveAttribute("height", "13");
        expect(within(list).getByText(fileName)).toBeVisible();
      }
    },
  );

  it("keeps filenames and status visible while moving file details into tooltips", () => {
    const fileName = "calibration-notes-with-a-long-descriptive-filename.md";
    const file: PendingAttachment = {
      localId: "file",
      fileName,
      mimeType: "text/markdown",
      size: 32,
      kind: "file",
      status: "ready",
    };
    const onRemove = vi.fn();
    const items: PendingAttachment[] = [
      file,
      {
        ...file,
        localId: "uploading",
        fileName: "results.csv",
        status: "uploading",
      },
      {
        ...file,
        localId: "error",
        fileName: "failed.csv",
        status: "error",
        error: "File upload failed. Remove it and add it again.",
      },
      ...(["attachment", "project"] as const).map((fileKind) => ({
        ...file,
        localId: fileKind,
        fileName: `${fileKind}.md`,
        recalledArtifact: {
          type: "file" as const,
          preview: true,
          scopeKey: "history-scope",
          viewId: "history-view",
          incarnation: null,
          effectiveLeafId: null,
          reference: `pi-file://${fileKind}`,
          fileKind,
        },
      })),
    ];
    const { rerender } = render(
      <AttachmentList
        sessionId="session-a"
        items={items}
        onRemove={onRemove}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText(fileName)).toBeVisible();
    expect(rows[0]).toHaveAttribute(
      "title",
      `${fileName}\ntext/markdown · 32 B`,
    );
    expect(
      screen.queryByText(/text\/markdown|32 B|project file|recalled file/),
    ).toBeNull();
    expect(within(rows[1]!).getByLabelText("Uploading")).toBeVisible();
    expect(rows[2]).toHaveAttribute(
      "title",
      `failed.csv\ntext/markdown · 32 B\n${items[2]!.error}`,
    );
    expect(within(rows[2]!).getByLabelText("Upload failed")).toHaveAttribute(
      "aria-description",
      items[2]!.error,
    );
    expect(rows[3]).toHaveAttribute("title", "attachment.md\nrecalled file");
    expect(rows[4]).toHaveAttribute("title", "project.md\nproject file");
    fireEvent.click(screen.getByRole("button", { name: `Remove ${fileName}` }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("file");
    rerender(
      <AttachmentList
        sessionId="session-a"
        items={items}
        disabled
        onRemove={onRemove}
      />,
    );
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps an ordinary image file's local preview after the Host confirms file delivery", () => {
    render(
      <AttachmentList
        sessionId="s"
        items={[
          {
            localId: "diagram",
            fileName: "diagram.svg",
            mimeType: "image/svg+xml",
            size: 42,
            kind: "file",
            previewUrl: "blob:diagram",
            status: "ready",
          },
        ]}
        onRemove={() => {}}
      />,
    );
    const preview = screen.getByRole("button", { name: "Preview diagram.svg" });
    expect(preview).toBeEnabled();
    expect(preview.querySelector("img")).toHaveAttribute("src", "blob:diagram");
  });

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
  it("budgets BMP and SVG as ordinary files even though the browser can preview them", () => {
    const size = Math.floor(MAX_PROMPT_IMAGE_BYTES / 2) + 1;
    const bitmap = file("one.bmp", size, "image/bmp");
    const diagram = file("two.svg", size, "image/svg+xml");
    expect(selectAttachmentFiles([], [bitmap, diagram])).toEqual({
      accepted: [bitmap, diagram],
      warning: null,
    });
    expect(selectAttachmentFiles([{ size, kind: "file" }], [diagram])).toEqual({
      accepted: [diagram],
      warning: null,
    });
  });
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

describe("persisted user images", () => {
  it("loads a stable embedded-image reference and opens a keyboard-accessible preview", async () => {
    const originalLoad = store.loadEmbeddedImage;
    const load = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    store.loadEmbeddedImage = load;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:persisted-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    try {
      render(
        <Transcript
          sessionId="s-images"
          viewId="view-images"
          messages={[
            {
              role: "user",
              content: [
                { type: "image", mimeType: "image/png" },
                { type: "text", text: "caption" },
              ],
              timestamp: 1,
              __inspireMessageIndex: 4,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );
      const thumbnail = await screen.findByRole("button", {
        name: "Preview attached image",
      });
      expect(load).toHaveBeenCalledWith(
        "s-images",
        "view-images",
        "view-images\u0000",
        "pi-embedded://4/0",
        expect.any(AbortSignal),
      );
      expect(screen.getByText("caption")).toBeInTheDocument();
      const thumbnailImage = within(thumbnail).getByRole("img", {
        name: "Attached image",
      });
      expect(thumbnailImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(thumbnailImage)).toBe(false);

      fireEvent.click(thumbnail);
      const preview = screen.getByRole("dialog", { name: "Image preview" });
      const previewImage = preview.querySelector("img")!;
      Object.defineProperties(previewImage, {
        naturalWidth: { value: 1200 },
        naturalHeight: { value: 800 },
      });
      fireEvent.load(previewImage);
      expect(previewImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(previewImage)).toBe(false);

      const actual = within(preview).getByRole("button", {
        name: "Actual size",
      });
      fireEvent.click(actual);
      expect(actual).toHaveTextContent("100%");
      fireEvent.keyDown(preview, { key: "+" });
      expect(actual).toHaveTextContent("125%");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Image preview" }),
        ).not.toBeInTheDocument(),
      );
    } finally {
      store.loadEmbeddedImage = originalLoad;
    }
  });
});
