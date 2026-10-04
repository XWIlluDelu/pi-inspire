import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  BRANCH_TREE_MAX_BYTES,
  BRANCH_TREE_MAX_NODES,
  boundedUserText,
  branchEntryContent,
  branchEntryText,
  projectSessionTree,
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

describe("bounded session branch tree", () => {
  it("orders branched entries, computes active ancestry, and exposes only safe snippets", () => {
    const entries = [
      message("u1", null, "user", "root question"),
      message("a1", "u1", "assistant", "first answer"),
      message("u2", "a1", "user", "abandoned prompt"),
      message("a2", "u2", "assistant", "abandoned answer"),
      message("branch", "a1", "assistant", "selected sibling"),
      {
        type: "label",
        id: "label",
        parentId: "branch",
        targetId: "branch",
        label: "Chosen path",
        timestamp: "2026-08-01T00:01:00.000Z",
      } as SessionEntry,
    ];
    const tree = projectSessionTree(entries, "branch");
    expect(tree.activePath).toEqual(["u1", "a1", "branch"]);
    expect(tree.nodes.map((node) => node.id)).toEqual(["u1", "a1", "branch"]);
    expect(tree.nodes.find((node) => node.id === "u1")).toMatchObject({
      canEdit: true,
      canFork: true,
    });
    const alternatives = projectSessionTree(entries, "branch", {
      parentId: "a1",
    });
    expect(alternatives.nodes.map((node) => node.id)).toEqual(["u2", "branch"]);
    expect(alternatives.nodes.find((node) => node.id === "u2")).toMatchObject({
      active: false,
      canEdit: true,
      canFork: true,
      routeLeafId: "a2",
    });
    expect(tree.nodes.find((node) => node.id === "branch")).toMatchObject({
      active: true,
      leaf: true,
      label: "Chosen path",
    });
    expect(JSON.stringify(tree)).not.toContain("apiKey");
  });

  it("bounds deep and large histories by node count and serialized bytes", () => {
    const entries: SessionEntry[] = [];
    let parent: string | null = null;
    for (let index = 0; index < BRANCH_TREE_MAX_NODES + 80; index += 1) {
      const id = `entry-${index}`;
      entries.push(
        message(
          id,
          parent,
          index === 0 ? "user" : "assistant",
          `content-${index}-${"x".repeat(400)}`,
        ),
      );
      parent = id;
    }
    const tree = projectSessionTree(entries, parent);
    expect(tree.truncated).toBe(true);
    expect(tree.nodes.length).toBeLessThanOrEqual(BRANCH_TREE_MAX_NODES);
    expect(
      Buffer.byteLength(
        JSON.stringify({ nodes: tree.nodes, activePath: tree.activePath }),
      ),
    ).toBeLessThanOrEqual(BRANCH_TREE_MAX_BYTES);
    expect(tree.nodes.at(-1)).toMatchObject({
      id: parent,
      leaf: true,
      active: true,
    });
    expect(tree.nodes[0]?.id).not.toBe("entry-0");
    expect(tree.leadingPrompt).toMatchObject({
      id: "entry-0",
      role: "user",
      canFork: true,
    });
    expect(tree.nextBefore).toBe(tree.nodes[0]!.id);
    expect(
      tree.activePath.every((id) => tree.nodes.some((node) => node.id === id)),
    ).toBe(true);
    expect(tree.nodes.every((node) => node.depth >= 0)).toBe(true);
  });

  it("pages every retained point and searches complete old/alternate text, not snippets", () => {
    const entries: SessionEntry[] = [];
    let parent: string | null = null;
    for (let index = 0; index < 1200; index++) {
      const id = `point-${index}`;
      entries.push(
        message(
          id,
          parent,
          index % 2 ? "assistant" : "user",
          index === 1
            ? `${"Long response. ".repeat(6000)}needle beyond the preview · 完整内容`
            : `Conversation point ${index}`,
        ),
      );
      parent = id;
    }
    entries.push(
      message("alternate", "point-4", "user", "Abandoned alternate input"),
    );
    let page = projectSessionTree(entries, parent);
    const ids = page.nodes.map((node) => node.id);
    while (page.nextBefore) {
      page = projectSessionTree(entries, parent, { before: page.nextBefore });
      ids.unshift(...page.nodes.map((node) => node.id));
    }
    expect(ids).toEqual(entries.slice(0, 1200).map((entry) => entry.id));
    const searched = projectSessionTree(entries, parent, {
      query: "needle beyond",
    });
    expect(searched.nodes.map((node) => node.id)).toEqual(["point-1"]);
    expect(searched.nodes[0]?.snippet).toContain("needle beyond");
    expect(branchEntryText(entries[1]!)).toContain("完整内容");
    expect(
      projectSessionTree(entries, parent, { query: "Abandoned alternate" })
        .nodes[0],
    ).toMatchObject({ id: "alternate", canFork: true, active: false });
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
    expect(
      projectSessionTree([system, toolCall, checkpoint], "checkpoint", {
        query: "private",
      }).nodes,
    ).toEqual([]);
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
      const node = projectSessionTree([shell], "shell").nodes[0];
      expect(node).toMatchObject({
        role: "shell",
        canEdit: false,
        canFork: false,
        canSwitch: true,
      });
      expect(branchEntryText(shell)).toContain(
        `${excludeFromContext ? "!!" : "!"}printf shell-marker`,
      );
      expect(branchEntryText(shell)).toContain("Exit 7");
      expect(branchEntryText(shell)).toContain(
        excludeFromContext ? "Excluded from context" : "Included in context",
      );
      expect(branchEntryText(shell)).not.toContain('"role"');
      for (const query of ["shell-marker", "native-result-marker"])
        expect(
          projectSessionTree([shell], "shell", { query }).nodes[0],
        ).toMatchObject({ id: "shell", role: "shell" });
    },
  );

  it("returns bounded original user text and rejects non-user targets", () => {
    const user = message("user", null, "user", "original text");
    expect(boundedUserText(user, 100)).toBe("original text");
    expect(() => boundedUserText(user, 3)).toThrow(/composer limit/);
    expect(() =>
      boundedUserText(message("assistant", "user", "assistant", "answer"), 100),
    ).toThrow(/not an editable user/);
  });

  it("rejects oversized raw entry and parent identities with a small typed error that never echoes them", () => {
    const oversized = "secret-" + "x".repeat(600);
    for (const entries of [
      [message(oversized, null, "user", "bad")],
      [message("safe", oversized, "assistant", "bad")],
    ]) {
      try {
        projectSessionTree(entries, entries[0]!.id);
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

  it("fails closed on missing parents and cycles instead of projecting ambiguous depth", () => {
    expect(() =>
      projectSessionTree([message("a", "missing", "assistant", "bad")], "a"),
    ).toThrow(/missing/);
    const cycle = [
      message("a", "b", "assistant", "a"),
      message("b", "a", "assistant", "b"),
    ];
    expect(() => projectSessionTree(cycle, "a")).toThrow();
  });
});
