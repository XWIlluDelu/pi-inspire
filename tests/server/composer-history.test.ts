import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";
import {
  composerHistoryEntries,
  projectComposerHistoryPage,
} from "../../server/composer-history.js";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
} from "../../shared/contracts.js";

const owner = {
  sessionId: "session-a",
  revision: 7,
  viewId: "view-a",
  incarnation: "projection-a",
  effectiveLeafId: "leaf-a",
};

describe("composer history projection", () => {
  it("reproduces Pi's trimmed, newest-first, consecutive-deduplicated history", () => {
    expect(
      composerHistoryEntries([
        { role: "user", content: "  one  " },
        { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "two" },
            { type: "image", data: "ignored" },
            { type: "text", text: " parts" },
          ],
        },
        { role: "user", content: "two parts" },
        { role: "user", content: "   " },
        { role: "user", content: "one" },
      ]),
    ).toEqual([
      { text: "one", images: [], files: [] },
      { text: "two parts", images: [], files: [] },
      { text: "one", images: [], files: [] },
    ]);

    const bounded = composerHistoryEntries(
      Array.from({ length: 105 }, (_, index) => ({
        role: "user",
        content: `prompt-${index}`,
      })),
    );
    expect(bounded).toHaveLength(MAX_COMPOSER_HISTORY_ENTRIES);
    expect(bounded[0]?.text).toBe("prompt-104");
    expect(bounded.at(-1)?.text).toBe("prompt-5");
  });

  it("projects text and image-only prompts as branch-scoped references", () => {
    const data = Buffer.from("pixels").toString("base64");
    expect(
      composerHistoryEntries([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data, mimeType: "image/png" },
          ],
        },
        {
          role: "user",
          content: [{ type: "image", data, mimeType: "image/webp" }],
        },
        {
          role: "user",
          content: [{ type: "image", data, mimeType: "image/webp" }],
        },
      ]),
    ).toEqual([
      {
        text: "",
        images: [
          {
            reference: "pi-embedded://1/0",
            mimeType: "image/webp",
            size: 6,
          },
        ],
        files: [],
      },
      {
        text: "look",
        images: [
          {
            reference: "pi-embedded://0/1",
            mimeType: "image/png",
            size: 6,
          },
        ],
        files: [],
      },
    ]);
  });

  it("projects ordinary and project files, including file-only prompts", () => {
    const projectFile = "/workspace/src/source.ts";
    const attachment = "/cache/uploads/report.pdf";
    const messages = [
      {
        role: "user",
        content: addAttachmentContext(
          "",
          [{ kind: "file", path: attachment }],
          [projectFile],
        ),
      },
      {
        role: "user",
        content: addAttachmentContext(
          "same text",
          [{ kind: "file", path: "/cache/uploads/first.txt" }],
          [],
        ),
      },
      {
        role: "user",
        content: addAttachmentContext(
          "same text",
          [{ kind: "file", path: "/cache/uploads/second.txt" }],
          [],
        ),
      },
    ];

    expect(composerHistoryEntries(messages, "/workspace")).toEqual([
      {
        text: "same text",
        images: [],
        files: [
          {
            reference: "pi-file://2/0",
            fileName: "second.txt",
            kind: "attachment",
          },
        ],
      },
      {
        text: "same text",
        images: [],
        files: [
          {
            reference: "pi-file://1/0",
            fileName: "first.txt",
            kind: "attachment",
          },
        ],
      },
      {
        text: "",
        images: [],
        files: [
          {
            reference: "pi-file://0/0",
            fileName: "source.ts",
            kind: "project",
          },
          {
            reference: "pi-file://0/1",
            fileName: "report.pdf",
            kind: "attachment",
          },
        ],
      },
    ]);
  });

  it("uses Host-owned display names without changing project-file names", () => {
    const workspace = resolve("/workspace");
    const stored = resolve("/cache/uploads/00000000-0000-4000-8000-report.pdf");
    const message = {
      role: "user",
      content: addAttachmentContext(
        "review",
        [{ kind: "file", path: stored }],
        [join(workspace, "src", "source.ts")],
      ),
    };

    expect(
      composerHistoryEntries([message], workspace, (path) =>
        path === stored ? "report.pdf" : null,
      )[0]?.files,
    ).toEqual([
      {
        reference: "pi-file://0/0",
        fileName: "source.ts",
        kind: "project",
      },
      {
        reference: "pi-file://0/1",
        fileName: "report.pdf",
        kind: "attachment",
      },
    ]);
  });

  it("pages exact entries under the serialized response bound", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: "user",
      content: `${index}:${"\0".repeat(10_000)}`,
    }));
    const first = projectComposerHistoryPage(messages, owner);
    expect(first.nextStart).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      MAX_COMPOSER_HISTORY_PAGE_BYTES,
    );

    const second = projectComposerHistoryPage(
      messages,
      owner,
      first.nextStart ?? 0,
    );
    expect(second.historyId).toBe(first.historyId);
    expect([...first.entries, ...second.entries]).toHaveLength(100);
    expect(second.nextStart).toBeNull();
  });
});
