import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  branchEntryContent,
  branchEntryText,
  indexSessionEntries,
} from "../../server/session-tree.js";

const message = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
): SessionEntry =>
  ({
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-01T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
    message: { role, content, timestamp: id.length },
  }) as SessionEntry;

describe("saved entry content", () => {
  it("keeps native system checkpoint bodies out of search/preview and uses ordinary keyed redaction", () => {
    const system = {
      ...message("system", null, "assistant", "private system body"),
      message: { role: "system", content: "private system body", timestamp: 1 },
    } as unknown as SessionEntry;
    const toolCall = {
      ...message("answer", "system", "assistant", ""),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "test",
            arguments: { apiKey: "secret value", output: "complete output" },
          },
        ],
        timestamp: 2,
      },
    } as unknown as SessionEntry;
    const checkpoint = {
      type: "compaction",
      id: "checkpoint",
      parentId: "answer",
      timestamp: "2026-01-01",
      summary: "Retained summary",
      firstKeptEntryId: "answer",
      tokensBefore: 10,
      systemMessage: {
        role: "system",
        content: "private checkpoint body",
        toolsAdded: [{ name: "private tool definition" }],
        timestamp: 3,
      },
    } as unknown as SessionEntry;
    expect(branchEntryText(system)).toBe("");
    expect(branchEntryContent(system)).toBeUndefined();
    expect(branchEntryText(checkpoint)).toBe("Retained summary");
    expect(branchEntryText(toolCall)).toContain("complete output");
    expect(branchEntryText(toolCall)).toContain("[redacted]");
    expect(branchEntryText(toolCall)).not.toContain("secret value");
  });

  it.each([false, true])(
    "projects native shell activity and finds complete command/output with excluded=%s",
    (excludeFromContext) => {
      const output = "retained ```output`\nlast line";
      const shell: SessionEntry = {
        type: "message",
        id: "shell",
        parentId: null,
        timestamp: "2026-10-02T00:00:00Z",
        message: {
          role: "bashExecution",
          command: "printf shell-marker",
          output,
          exitCode: 7,
          cancelled: false,
          truncated: false,
          excludeFromContext,
          timestamp: 1,
        },
      };
      const text = branchEntryText(shell);
      expect(text).toContain(output);
      expect(text).toContain(
        `${excludeFromContext ? "!!" : "!"}printf shell-marker`,
      );
      expect(text).toContain("Exit 7");
      expect(text).toContain(
        excludeFromContext ? "Excluded from context" : "Included in context",
      );
    },
  );

  it("rejects oversized raw entry and parent identities with a small typed error that never echoes them", () => {
    const oversized = "secret-" + "x".repeat(600);
    for (const entries of [
      [message(oversized, null, "user", "bad")],
      [message("safe", oversized, "assistant", "bad")],
    ]) {
      try {
        indexSessionEntries(entries);
        throw new Error("expected identity rejection");
      } catch (error) {
        expect(error).toMatchObject({ status: 422 });
        expect(String((error as Error).message)).not.toContain(oversized);
        expect(
          Buffer.byteLength(String((error as Error).message)),
        ).toBeLessThan(100);
      }
    }
  });
});
