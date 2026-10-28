import { describe, expect, it, vi } from "vitest";
import type { ResourceDescriptor } from "../../shared/contracts";
import { decodeTextPreview } from "../../shared/text-preview";
import { ResourceController } from "../../src/controllers/resource-controller";

const text = '$message = "你好 🌍"\r\nWrite-Output $message\r\n';

function unicodeBytes(
  text: string,
  encoding: "utf-8" | "utf-16le" | "utf-16be",
): Uint8Array<ArrayBuffer> {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, encoding === "utf-16le");
  for (let index = 0; index < text.length; index++)
    view.setUint16(
      2 + index * 2,
      text.charCodeAt(index),
      encoding === "utf-16le",
    );
  return bytes;
}

describe("bounded Unicode file text", () => {
  it.each(["utf-8", "utf-16le", "utf-16be"] as const)(
    "decodes %s without changing line endings or Unicode",
    (encoding) => {
      expect(decodeTextPreview(unicodeBytes(text, encoding))).toBe(text);
    },
  );

  it("keeps BOM-less input UTF-8 and removes the UTF-8 BOM", () => {
    expect(
      decodeTextPreview(
        new Uint8Array([0xef, 0xbb, 0xbf, ...unicodeBytes(text, "utf-8")]),
      ),
    ).toBe(text);
    expect(decodeTextPreview(new Uint8Array([0xff]))).toBe("�");
    expect(decodeTextPreview(new Uint8Array())).toBe("");
  });

  it.each(["utf-8", "utf-16le", "utf-16be"] as const)(
    "does not invent a trailing replacement at a %s transfer cap",
    (encoding) => {
      const bytes = unicodeBytes("first 🌍", encoding);
      expect(decodeTextPreview(bytes.subarray(0, bytes.length - 1), true)).toBe(
        "first ",
      );
      expect(decodeTextPreview(bytes.subarray(0, bytes.length - 1))).toContain(
        "�",
      );
    },
  );
});

describe("authorized Unicode resource previews", () => {
  it.each([
    ["text", "startup.ps1", "text/plain", text],
    ["markdown", "notes.md", "text/markdown", "# 你好 🌍\r\n"],
    [
      "notebook",
      "analysis.ipynb",
      "application/x-ipynb+json",
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4 }),
    ],
    [
      "html",
      "index.html",
      "text/html",
      '<html><head><meta charset="utf-16"></head><body>你好 🌍</body></html>',
    ],
    [
      "image",
      "drawing.svg",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>你好 🌍</text></svg>',
    ],
  ] as const)(
    "decodes the %s reader while retaining the original download bytes",
    async (kind, reference, mimeType, source) => {
      const bytes = unicodeBytes(source, "utf-16le");
      const blob = new Blob([bytes], { type: mimeType });
      const descriptor: ResourceDescriptor = {
        id: "unicode",
        sessionId: "session",
        viewId: "view",
        reference,
        name: reference,
        mimeType,
        kind,
        size: bytes.length,
      };
      type Host = ConstructorParameters<typeof ResourceController>[0];
      const state: ReturnType<Host["state"]> = {
        sessionId: "session",
        transcriptViewId: "view",
        transcriptIncarnation: "incarnation",
        transcriptRevision: 1,
        resourcesOpen: false,
        contextMode: "files",
        fileBrowserView: "browse",
        selectedResourceReference: null,
        selectedResourceWorkspacePath: null,
        resourcePreview: null,
        resourceTabs: [],
        resourceAvailability: {},
        resourceWorkspacePaths: {},
      };
      const createUrl = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:unicode");
      const content = vi.fn().mockResolvedValue({ blob, totalSize: blob.size });
      const api = {
        resolveResource: vi.fn().mockResolvedValue(descriptor),
        resourceContent: content,
      } as unknown as ReturnType<Host["api"]>;
      const host: Host = {
        state: () => state,
        patch: (patch) => Object.assign(state, patch),
        api: () => api,
        transportGeneration: () => 1,
        handleAuthFailure: vi.fn(),
        saveDownload: vi.fn(),
        prepareGitForResourceOpen: () => () => true,
        selectWorkspacePath: vi.fn(),
      };
      const controller = new ResourceController(host);
      try {
        await controller.openResource(reference);
        expect(state.resourcePreview).toMatchObject({
          status: "ready",
          text: source,
          truncated: false,
          descriptor: { size: bytes.length },
        });
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
        if (kind === "html") {
          const documentBlob = createUrl.mock.calls[0]![0] as Blob;
          expect(documentBlob.type).toBe("text/html;charset=utf-8");
          expect(await documentBlob.text()).toContain("你好 🌍");
          expect(await documentBlob.text()).toContain(
            "Content-Security-Policy",
          );
        } else if (kind === "image") {
          expect(createUrl).toHaveBeenCalledWith(blob);
        }
      } finally {
        controller.invalidate();
        createUrl.mockRestore();
      }
    },
  );
});
