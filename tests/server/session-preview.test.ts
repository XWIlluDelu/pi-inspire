import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionPreview } from "../../server/session-preview.js";
import type { SessionRecord } from "../../server/session-catalog.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadSessionPreview", () => {
  it("projects the active Pi branch without modifying its JSONL file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-preview-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const lines = [
      { type: "session", version: 3, id: "session-a", timestamp: "2026-07-22T00:00:00.000Z", cwd: "/project" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-22T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], provider: "test", model: "model-a", stopReason: "stop", timestamp: 2 } },
      { type: "thinking_level_change", id: "t1", parentId: "a1", timestamp: "2026-07-22T00:00:03.000Z", thinkingLevel: "high" },
      { type: "custom", id: "c1", parentId: "t1", timestamp: "2026-07-22T00:00:04.000Z", customType: "example", data: { seen: true } },
    ];
    const original = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await writeFile(path, original);
    const record: SessionRecord = {
      id: "session-a",
      cwd: "/project",
      path,
      name: "Preview session",
      created: new Date("2026-07-22T00:00:00.000Z"),
      modified: new Date("2026-07-22T00:00:04.000Z"),
      messageCount: 2,
      firstMessage: "hello",
      searchText: "hello",
    };

    const preview = await loadSessionPreview(record);

    expect(preview).toMatchObject({
      sessionId: "session-a",
      sessionName: "Preview session",
      cwd: "/project",
      model: { provider: "test", id: "model-a" },
      thinkingLevel: "high",
      isStreaming: false,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", provider: "test", model: "model-a" },
      ],
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
