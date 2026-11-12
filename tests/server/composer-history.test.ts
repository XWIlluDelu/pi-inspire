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
  composerHistoryVersion: "history-a",
};

describe("composer history projection", () => {
  it("reproduces Pi's trimmed, newest-first, consecutive-deduplicated history", () => {
    expect(
      composerHistoryEntries([
        {
          __inspireHistoryEntryId: "one-first",
          role: "user",
          content: "  one  ",
        },
        {
          __inspireHistoryEntryId: "answer",
          role: "assistant",
          content: [{ type: "text", text: "ignored" }],
        },
        {
          __inspireHistoryEntryId: "two-first",
          role: "user",
          content: [
            { type: "text", text: "two" },
            { type: "image", data: "ignored" },
            { type: "text", text: " parts" },
          ],
        },
        {
          __inspireHistoryEntryId: "two-again",
          role: "user",
          content: "two parts",
        },
        { __inspireHistoryEntryId: "blank", role: "user", content: "   " },
        { __inspireHistoryEntryId: "one-again", role: "user", content: "one" },
      ]),
    ).toEqual([
      { text: "one", images: [], files: [] },
      { text: "two parts", images: [], files: [] },
      { text: "one", images: [], files: [] },
    ]);

    const bounded = composerHistoryEntries(
      Array.from({ length: 105 }, (_, index) => ({
        __inspireHistoryEntryId: String(index),
        role: "user",
        content: `prompt-${index}`,
      })),
    );
    expect(bounded).toHaveLength(MAX_COMPOSER_HISTORY_ENTRIES);
    expect(bounded[0]?.text).toBe("prompt-104");
    expect(bounded.at(-1)?.text).toBe("prompt-5");
  });

  it("stops projecting old artifacts after the retained prompt limit", () => {
    const obsolete = {
      __inspireHistoryEntryId: "obsolete",
      role: "user",
      get content(): string {
        throw new Error("Obsolete artifacts should not be projected");
      },
    };
    const recent = Array.from(
      { length: MAX_COMPOSER_HISTORY_ENTRIES + 1 },
      (_, index) => ({
        __inspireHistoryEntryId: String(index),
        role: "user",
        content: `recent-${index}`,
      }),
    );
    const history = composerHistoryEntries([obsolete, ...recent]);
    expect(history).toHaveLength(MAX_COMPOSER_HISTORY_ENTRIES);
    expect(history.at(-1)?.text).toBe("recent-1");
  });

  it("projects text and image-only prompts as branch-scoped references", () => {
    const data = Buffer.from("pixels").toString("base64");
    expect(
      composerHistoryEntries([
        {
          __inspireHistoryEntryId: "entry-0",
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data, mimeType: "image/png" },
          ],
        },
        {
          __inspireHistoryEntryId: "entry-1",
          role: "user",
          content: [{ type: "image", data, mimeType: "image/webp" }],
        },
        {
          __inspireHistoryEntryId: "entry-2",
          role: "user",
          content: [{ type: "image", data, mimeType: "image/webp" }],
        },
      ]),
    ).toEqual([
      {
        text: "",
        images: [
          {
            reference: "pi-history-image://entry-1/0",
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
            reference: "pi-history-image://entry-0/1",
            mimeType: "image/png",
            size: 6,
          },
        ],
        files: [],
      },
    ]);
  });

  it("recalls image prompts without Pi dimension hints while preserving source and artifact coordinates", () => {
    const sourceText =
      "inspect\n\n[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";
    const message = {
      __inspireHistoryEntryId: "entry-0",
      role: "user",
      content: [
        { type: "text", text: sourceText },
        { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
      ],
    };
    expect(composerHistoryEntries([message])).toEqual([
      {
        text: "inspect",
        images: [
          {
            reference: "pi-history-image://entry-0/1",
            mimeType: "image/png",
            size: 6,
          },
        ],
        files: [],
      },
    ]);
    expect(message.content[0]?.text).toBe(sourceText);
  });

  it("recalls files and images together when Pi appended a dimension note", () => {
    const path = resolve("report.md");
    const content =
      addAttachmentContext("Inspect", [], [path]) +
      "\n\n[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";
    const message = {
      __inspireHistoryEntryId: "entry-0",
      role: "user",
      content: [
        { type: "text", text: content },
        { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
      ],
    };
    const history = composerHistoryEntries([message]);
    expect(history[0]?.text).toBe("Inspect");
    expect(history[0]?.files).toHaveLength(1);
    expect(history[0]?.files[0]?.reference).toBe("pi-history-file://entry-0/0");
    expect(history[0]?.images[0]?.reference).toBe(
      "pi-history-image://entry-0/1",
    );
    expect(message.content[0]?.text).toBe(content);
  });

  it("projects ordinary and project files, including file-only prompts", () => {
    const projectFile = "/workspace/src/source.ts";
    const attachment = "/cache/uploads/report.pdf";
    const messages = [
      {
        __inspireHistoryEntryId: "entry-0",
        role: "user",
        content: addAttachmentContext(
          "",
          [{ kind: "file", path: attachment }],
          [projectFile],
        ),
      },
      {
        __inspireHistoryEntryId: "entry-1",
        role: "user",
        content: addAttachmentContext(
          "same text",
          [{ kind: "file", path: "/cache/uploads/first.txt" }],
          [],
        ),
      },
      {
        __inspireHistoryEntryId: "entry-2",
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
            reference: "pi-history-file://entry-2/0",
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
            reference: "pi-history-file://entry-1/0",
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
            reference: "pi-history-file://entry-0/0",
            fileName: "source.ts",
            kind: "project",
          },
          {
            reference: "pi-history-file://entry-0/1",
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
      __inspireHistoryEntryId: "entry-0",
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
        reference: "pi-history-file://entry-0/0",
        fileName: "source.ts",
        kind: "project",
      },
      {
        reference: "pi-history-file://entry-0/1",
        fileName: "report.pdf",
        kind: "attachment",
      },
    ]);
  });

  it("pages exact entries under the serialized response bound", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      __inspireHistoryEntryId: String(index),
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
