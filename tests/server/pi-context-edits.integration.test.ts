import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piInstallation } from "../../server/pi-installation.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { SessionProjection } from "../../server/session-projection.js";

const { SessionManager, buildSessionContext } = piInstallation.sdk;
const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-context-edit-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const id = "context-edit-session";
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      cwd: directory,
      timestamp: new Date(0).toISOString(),
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "original user text", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(2).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "original assistant text" }],
        api: "openai-completions",
        provider: "offline",
        model: "fixture",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  await writeFile(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const record: SessionRecord = {
    id,
    path,
    source: null,
    cwd: directory,
    created: new Date(0),
    modified: new Date(2),
    messageCount: 2,
    firstMessage: "original user text",
    searchText: "original user text",
  };
  return { path, record, manager: SessionManager.open(path, directory) };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi context edits and transcript projection", () => {
  it.each(["omit", "replace"] as const)(
    "preserves raw UI history when Pi edits assistant context: %s",
    async (operation) => {
      const { path, record, manager } = await fixture();
      const projection = await SessionProjection.open(record);
      try {
        const original = projection.latestPage().messages;
        const editId = manager.appendContextEdit(
          "a1",
          operation === "omit" ? null : { content: "replacement context" },
        );
        await expect(projection.reconcile(true)).resolves.toMatchObject({
          changed: true,
          kind: "append",
          appendedEntries: [
            expect.objectContaining({ type: "context_edit", id: editId }),
          ],
        });
        expect(projection.health.status).toBe("ok");
        expect(projection.latestPage().messages).toEqual(original);
        const assistantContext = buildSessionContext(
          manager.getEntries(),
        ).messages.filter((message) => message.role === "assistant");
        expect(assistantContext.map((message) => message.content)).toEqual(
          operation === "omit"
            ? []
            : [[{ type: "text", text: "replacement context" }]],
        );
        const bytes = await readFile(path);
        const reopened = await SessionProjection.open(record);
        try {
          expect(reopened.latestPage().messages).toEqual(original);
          expect(await readFile(path)).toEqual(bytes);
        } finally {
          await reopened.close();
        }
      } finally {
        await projection.close();
      }
    },
  );

  it("projects retain-none compaction and subsequent input without restoring old messages", async () => {
    const { record, manager } = await fixture();
    const projection = await SessionProjection.open(record);
    try {
      const compactionId = manager.appendCompaction(
        "retained summary",
        null,
        15,
      );
      expect(manager.getEntry(compactionId)).toMatchObject({
        type: "compaction",
        firstKeptEntryId: compactionId,
      });
      manager.appendMessage({
        role: "user",
        content: "after compaction",
        timestamp: 3,
      });
      await projection.reconcile(true);
      expect(projection.health.status).toBe("ok");
      const messages = projection.latestPage().messages;
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).toContain("retained summary");
      expect(JSON.stringify(messages)).not.toContain("original user text");
      expect(JSON.stringify(messages)).not.toContain("original assistant text");
      expect(messages[1]).toMatchObject({
        role: "user",
        content: "after compaction",
      });
    } finally {
      await projection.close();
    }
  });
});
