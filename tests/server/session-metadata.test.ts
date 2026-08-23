import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMetadataIndex } from "../../server/session-metadata.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "inspire-session-metadata-"));
  directories.push(path);
  return path;
}

function header(id = "session-a") {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/project",
  };
}

function message(
  id: string,
  role: "user" | "assistant" | "toolResult",
  content: string,
  timestamp: number,
) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("SessionMetadataIndex", () => {
  it("projects only bounded catalog metadata from Pi JSONL", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      [
        header(),
        { type: "session_info", id: "n1", name: " Old name " },
        message("t1", "toolResult", "tool output", 1_767_225_601_000),
        message("u1", "user", "first prompt", 1_767_225_602_000),
        message("a1", "assistant", "answer", 1_767_225_603_000),
        { type: "session_info", id: "n2", name: " Current name " },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const records = await new SessionMetadataIndex().list(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "session-a",
      cwd: "/work/project",
      name: "Current name",
      firstMessage: "first prompt",
      messageCount: 3,
      searchText: "current name\nfirst prompt\n/work/project",
    });
    expect(records[0]?.modified.toISOString()).toBe("2026-01-01T00:00:03.000Z");
    expect(records[0]).not.toHaveProperty("allMessagesText");
  });

  it("reuses unchanged summaries and rescans only a changed file", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${JSON.stringify(
        message("u1", "user", "one", 1_767_225_601_000),
      )}\n`,
    );
    const index = new SessionMetadataIndex();
    const first = await index.list(root);
    const unchanged = await index.list(root);
    expect(unchanged[0]).toBe(first[0]);

    await appendFile(
      path,
      `${JSON.stringify(
        message("a1", "assistant", "two", 1_767_225_602_000),
      )}\n`,
    );
    const changed = await index.list(root);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]).toMatchObject({ messageCount: 2 });
  });

  it("resumes an incomplete final frame without recounting the prefix", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    const entry = JSON.stringify(
      message("u1", "user", "split frame", 1_767_225_601_000),
    );
    const split = Math.floor(entry.length / 2);
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${entry.slice(0, split)}`,
    );
    const index = new SessionMetadataIndex();
    expect((await index.list(root))[0]).toMatchObject({
      messageCount: 0,
      firstMessage: "",
    });

    await appendFile(path, `${entry.slice(split)}\n`);
    expect((await index.list(root))[0]).toMatchObject({
      messageCount: 1,
      firstMessage: "split frame",
    });
  });

  it("omits a stable malformed file and discovers it after a valid rewrite", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n{broken}\n`);
    const index = new SessionMetadataIndex();
    expect(await index.list(root)).toEqual([]);
    expect(await index.list(root)).toEqual([]);

    await writeFile(
      path,
      `${JSON.stringify(header())}\n${JSON.stringify(
        message("u1", "user", "repaired", 1_767_225_601_000),
      )}\n`,
    );
    expect((await index.list(root))[0]).toMatchObject({
      id: "session-a",
      firstMessage: "repaired",
    });
  });

  it("leaves whitespace-only conversations untitled", async () => {
    const root = await directory();
    await writeFile(
      join(root, "empty.jsonl"),
      `${JSON.stringify(header())}\n${JSON.stringify(
        message("u1", "user", "   ", 1_767_225_601_000),
      )}\n`,
    );
    expect((await new SessionMetadataIndex().list(root))[0]).toMatchObject({
      firstMessage: "",
    });
  });
});
