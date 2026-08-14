import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_TREE_MAX_BYTES,
  BRANCH_TREE_MAX_NODES,
  boundedUserText,
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
    expect(tree.nodes.map((node) => node.id)).toEqual(
      entries.map((entry) => entry.id),
    );
    expect(tree.nodes.find((node) => node.id === "u2")).toMatchObject({
      active: false,
      canEdit: true,
      canFork: false,
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
          index % 2 ? "assistant" : "user",
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
    expect(
      tree.activePath.every((id) => tree.nodes.some((node) => node.id === id)),
    ).toBe(true);
    expect(tree.nodes.every((node) => node.depth >= 0)).toBe(true);
  });

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
