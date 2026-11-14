import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  branchEntryContent,
  branchEntryText,
  branchRouteLabel,
  indexSessionEntries,
  sessionRoutes,
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

describe("saved history entries and branch routes", () => {
  it("pages direct routes, preserves labels, and marks the route containing the live leaf", () => {
    const fork = message("root", null, "user", "Start");
    const entries = [
      fork,
      ...Array.from({ length: 104 }, (_, index) =>
        message(`child-${index}`, fork.id, "assistant", `Answer ${index}`),
      ),
      {
        type: "label",
        id: "bookmark",
        parentId: "child-103",
        targetId: "child-103",
        label: "Chosen path",
        timestamp: "2026-08-01",
      } as SessionEntry,
    ];
    const byId = indexSessionEntries(entries);
    const latest = sessionRoutes(entries, byId, "bookmark", fork.id);
    expect(latest.nodes).toHaveLength(100);
    expect(latest.nodes.at(-1)).toEqual({
      id: "child-103",
      label: "Chosen path",
      leafId: "bookmark",
      current: true,
    });
    const older = sessionRoutes(
      entries,
      byId,
      "bookmark",
      fork.id,
      latest.nextBefore!,
    );
    expect(older.nodes.map((node) => node.id)).toEqual([
      "child-0",
      "child-1",
      "child-2",
      "child-3",
    ]);
    expect(older.nextBefore).toBeNull();
    expect(
      sessionRoutes(entries, byId, "bookmark", null).nodes[0],
    ).toMatchObject({
      id: "root",
      current: true,
    });
    expect(() =>
      sessionRoutes(entries, byId, "bookmark", fork.id, "missing"),
    ).toThrow(/routes changed/);
  });

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
      const shell: SessionEntry = {
        type: "message",
        id: "shell",
        parentId: null,
        timestamp: "2026-10-02T00:00:00Z",
        message: {
          role: "bashExecution",
          command: "printf shell-marker",
          output: `${"retained output\\n".repeat(100)}native-result-marker`,
          exitCode: 7,
          cancelled: false,
          truncated: false,
          excludeFromContext,
          timestamp: 1,
        },
      };
      expect(branchEntryText(shell)).toContain(
        `${excludeFromContext ? "!!" : "!"}printf shell-marker`,
      );
      expect(branchEntryText(shell)).toContain("Exit 7");
      expect(branchEntryText(shell)).toContain(
        excludeFromContext ? "Excluded from context" : "Included in context",
      );
    },
  );

  it("keeps readable outlines within the preview bound", () => {
    const mixed = message("preview", null, "assistant", "");
    Object.assign(
      (mixed as Extract<SessionEntry, { type: "message" }>).message,
      {
        content: [
          { type: "text", text: " \nFirst block\t " },
          { type: "thinking", thinking: "\nThought\tprocess" },
          { type: "image", mimeType: "image/png", data: "unused" },
          { type: "text", text: "Last block" },
        ],
      },
    );
    expect(branchRouteLabel(mixed)).toBe(
      "First block Thinking Thought process [Image: image/png] Last block",
    );

    const entry = message("lazy-preview", null, "assistant", "");
    Object.assign(
      (entry as Extract<SessionEntry, { type: "message" }>).message,
      {
        content: [
          { type: "text", text: "x".repeat(1000) },
          { type: "text", text: "second block beyond the preview" },
        ],
      },
    );
    const preview = branchRouteLabel(entry);
    expect(preview.startsWith("x")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(240);
  });

  it("keeps complete shell output containing many backtick runs literal", () => {
    const output = "`x".repeat(150_000);
    const entry: SessionEntry = {
      type: "message",
      id: "shell",
      parentId: null,
      timestamp: "2026-10-05",
      message: {
        role: "bashExecution",
        command: "echo ```",
        output,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      },
    };
    const text = branchEntryText(entry);
    expect(text).toContain(output);
    expect(text).toContain("!echo ```");
    expect(branchRouteLabel(entry).length).toBeLessThanOrEqual(240);
  });

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
