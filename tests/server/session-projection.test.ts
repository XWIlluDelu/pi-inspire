import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedTranscriptValue,
  MAX_PERSISTED_ENTRY_BYTES,
  SessionProjection,
  type SessionProjectionReadHooks,
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSCRIPT_PAGE_MAX_MESSAGES,
} from "../../server/session-projection.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { collectSessionResourceReferences } from "../../shared/resource-references.js";

const directories: string[] = [];
const header = (id = "session-a") => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-08-01T00:00:00.000Z",
  cwd: "/project",
});
const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  timestamp: number,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: { role, content, timestamp },
});

async function fixture(
  lines: unknown[],
  id = "session-a",
  readHooks?: SessionProjectionReadHooks,
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-projection-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const bytes = `${[header(id), ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`;
  await writeFile(path, bytes);
  const record: SessionRecord = {
    id,
    path,
    source: null,
    cwd: "/project",
    name: "Projection",
    created: new Date(),
    modified: new Date(),
    messageCount: lines.length,
    firstMessage: "",
    searchText: "",
  };
  return {
    directory,
    path,
    bytes,
    record,
    projection: await SessionProjection.open(record, readHooks),
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SessionProjection framing and last-good state", () => {
  it("keeps a Pi-owned new session healthy until its reported JSONL path first materializes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-pending-projection-"),
    );
    directories.push(directory);
    const path = join(directory, "pending-session.jsonl");
    const record: SessionRecord = {
      id: "pending-session",
      path,
      source: null,
      cwd: "/project",
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      searchText: "",
    };
    const projection = await SessionProjection.openPending(record);
    try {
      expect(projection).toMatchObject({
        revision: 1,
        fingerprint: "",
        sourceIdentity: null,
        health: { status: "ok" },
      });
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        changed: false,
        kind: "none",
        sourceChanged: false,
      });

      const model = {
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-08-01T00:00:01.000Z",
        provider: "test",
        modelId: "model",
      };
      const thinking = {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "model-1",
        timestamp: "2026-08-01T00:00:02.000Z",
        thinkingLevel: "medium",
      };
      await writeFile(
        path,
        `${[header("pending-session"), model, thinking].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        changed: true,
        kind: "append",
        previousRevision: 1,
        revision: 2,
        previousSourceVersion: null,
        appendedEntries: [model, thinking],
        previousLeafId: null,
      });
      expect(projection).toMatchObject({
        sourceIdentity: expect.any(String),
        health: { status: "ok" },
      });
    } finally {
      await projection.close();
    }
  });

  it("tracks an incomplete first header until the owned new session completes it", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-partial-header-projection-"),
    );
    directories.push(directory);
    const path = join(directory, "pending-session.jsonl");
    const record: SessionRecord = {
      id: "pending-session",
      path,
      source: null,
      cwd: "/project",
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      searchText: "",
    };
    const projection = await SessionProjection.openPending(record);
    await projection.suspendReconciliation();
    try {
      const serialized = JSON.stringify(header("pending-session"));
      await writeFile(path, serialized.slice(0, -1));
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: false,
        kind: "none",
        sourceChanged: true,
        committedBytes: 0,
        uncommittedBytes: Buffer.byteLength(serialized) - 1,
        health: { status: "ok" },
      });
      expect(projection.attestInitialMaterialization("/project", [])).toBe(
        "partial",
      );

      await appendFile(path, `${serialized.slice(-1)}\n`);
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: true,
        kind: "append",
        previousTailVerified: true,
        appendedEntries: [],
        uncommittedBytes: 0,
        health: { status: "ok" },
      });
      expect(projection.attestInitialMaterialization("/project", [])).toBe(
        "complete",
      );
    } finally {
      projection.resumeReconciliation();
      await projection.close();
    }
  });

  it("still rejects a missing JSONL on an ordinary existing-session open", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-missing-projection-"),
    );
    directories.push(directory);
    const record: SessionRecord = {
      id: "missing-session",
      path: join(directory, "missing.jsonl"),
      source: null,
      cwd: directory,
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "missing",
      searchText: "missing",
    };
    await expect(SessionProjection.open(record)).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });

  it("uses transcript-specific projection budgets with the shared sensitive-key policy", () => {
    const projected = boundedTranscriptValue({
      authorization: "secret",
      nested: { token: "secret", text: "x".repeat(70_000) },
    }) as Record<string, unknown>;
    expect(projected.authorization).toBe("[redacted]");
    expect((projected.nested as Record<string, unknown>).token).toBe(
      "[redacted]",
    );
    expect(String((projected.nested as Record<string, unknown>).text)).toMatch(
      /truncated/,
    );
  });

  it("retains projection identity after object breadth is bounded", () => {
    const projected = boundedTranscriptValue({
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          `field-${index}`,
          "x".repeat(4_000),
        ]),
      ),
      __inspireMessageId: "entry-id:0",
      __inspireEntryId: "entry-id",
      __inspireLiveId: "live-id",
      __inspireSettled: false,
    }) as Record<string, unknown>;
    expect(projected).toMatchObject({
      __inspireMessageId: "entry-id:0",
      __inspireEntryId: "entry-id",
      __inspireLiveId: "live-id",
      __inspireSettled: false,
    });
  });

  it("keeps an oversized activity-only assistant message classified as activity", () => {
    const densePart = {
      type: "toolCall",
      ...Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `argument-${index}`,
          "x".repeat(4_000),
        ]),
      ),
    };
    const projected = boundedTranscriptValue({
      role: "assistant",
      content: Array.from({ length: 64 }, () => densePart),
      __inspireMessageId: "activity-id",
    }) as Record<string, unknown>;
    expect(projected.__inspireMessageId).toBe("activity-id");
    expect(projected.content).toEqual([
      {
        type: "projectionOmitted",
        content:
          "[message omitted: projected content exceeded the transcript item limit]",
      },
    ]);
  });

  it("keeps persisted image bytes server-side while exposing stable browser references", async () => {
    const data = Buffer.alloc(512 * 1024, 7).toString("base64");
    const { projection } = await fixture([
      message(
        "u1",
        null,
        "user",
        [
          { type: "text", text: "two images" },
          { type: "image", data, mimeType: "image/png" },
          { type: "image", data: "different", mimeType: "image/webp" },
        ],
        1,
      ),
    ]);
    try {
      const projected = projection.latestPage().messages[0] as Record<
        string,
        unknown
      >;
      expect(projected.__inspireMessageIndex).toBe(0);
      expect(projected.content).toEqual([
        { type: "text", text: "two images" },
        { type: "image", mimeType: "image/png" },
        { type: "image", mimeType: "image/webp" },
      ]);
      expect(JSON.stringify(projection.latestPage())).not.toContain(
        data.slice(0, 128),
      );
      expect(
        collectSessionResourceReferences([projected]).map(
          (item) => item.reference,
        ),
      ).toEqual(["pi-embedded://0/2", "pi-embedded://0/1"]);
      expect(
        (projection.messages[0] as { content: Array<{ data?: string }> })
          .content[1]!.data,
      ).toBe(data);
    } finally {
      await projection.close();
    }
  });

  it("keeps UTF-8 split-safe framing and a partial final line private until LF", async () => {
    const padding = "x".repeat(65_500);
    const first = message("u1", null, "user", `${padding}你`, 1);
    const { path, projection } = await fixture([first]);
    try {
      const partial = JSON.stringify(
        message("a1", "u1", "assistant", [{ type: "text", text: "完整" }], 2),
      );
      await appendFile(path, partial.slice(0, -3));
      const withheld = await projection.reconcile(true);
      expect(withheld.changed).toBe(false);
      expect(projection.messages).toHaveLength(1);

      await appendFile(path, `${partial.slice(-3)}\n`);
      const completed = await projection.reconcile(true);
      expect(completed.changed).toBe(true);
      expect(projection.messages).toHaveLength(2);
      expect(JSON.stringify(projection.messages.at(-1))).toContain("完整");
    } finally {
      await projection.close();
    }
  });

  it("surfaces unresolved source tails and verifies their exact completion provenance", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    try {
      const revision = projection.revision;
      const sourceVersion = projection.sourceVersion;
      const next = JSON.stringify(
        message("a1", "u1", "assistant", "completed", 2),
      );
      await appendFile(path, next.slice(0, -4));
      const partial = await projection.reconcile(true);
      expect(partial).toMatchObject({
        changed: false,
        sourceChanged: true,
        previousUncommittedBytes: 0,
        uncommittedBytes: Buffer.byteLength(next.slice(0, -4)),
      });
      expect(projection.revision).toBe(revision);
      expect(projection.sourceVersion).not.toBe(sourceVersion);
      expect(projection.uncommittedBytes).toBeGreaterThan(0);

      await appendFile(path, `${next.slice(-4)}\n`);
      const completed = await projection.reconcile(true);
      expect(completed).toMatchObject({
        changed: true,
        kind: "append",
        uncommittedBytes: 0,
        previousTailVerified: true,
      });
      expect(projection.messages.at(-1)).toMatchObject({
        content: "completed",
      });
    } finally {
      await projection.close();
    }
  });

  it("surfaces truncation or replacement of an unresolved tail instead of treating it as completion", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    try {
      const committed = projection.committedBytes;
      await appendFile(path, '{"type":"message"');
      await projection.reconcile(true);
      expect(projection.uncommittedBytes).toBeGreaterThan(0);

      await truncate(path, committed);
      const truncated = await projection.reconcile(true);
      expect(truncated).toMatchObject({
        changed: false,
        sourceChanged: true,
        uncommittedBytes: 0,
        previousTailVerified: false,
      });

      await appendFile(path, "partial-a");
      await projection.reconcile(true);
      await writeFile(
        path,
        `${(await readFile(path)).subarray(0, committed).toString()}partial-b`,
      );
      const rewritten = await projection.reconcile(true);
      expect(rewritten).toMatchObject({
        sourceChanged: true,
        previousTailVerified: false,
      });
    } finally {
      await projection.close();
    }
  });

  it("drains an in-flight reconcile while closing without an unhandled rejection", async () => {
    const { projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    const internals = projection as unknown as {
      reconcileOnce(force: boolean): Promise<unknown>;
    };
    const original = internals.reconcileOnce.bind(projection);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const entered = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    internals.reconcileOnce = async (force) => {
      started();
      await gate;
      return original(force);
    };
    const reconciling = projection.reconcile(true);
    await entered;
    const closing = projection.close();
    release();
    await expect(reconciling).rejects.toThrow(/closed/);
    await expect(closing).resolves.toBeUndefined();
  });

  // This intentionally streams a 32 MiB + 1 byte adversarial entry. It has
  // no external dependency, but may legitimately exceed Vitest's 5s default
  // when the full server suite is CPU- and I/O-contended in CI.
  it("retains last-good projection for malformed, oversized, and wrong-session replacements", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    try {
      const revision = projection.revision;
      await appendFile(path, "{malformed}\n");
      await projection.reconcile(true);
      expect(projection.revision).toBe(revision);
      expect(projection.health).toMatchObject({
        status: "error",
        message: expect.stringMatching(/malformed/),
      });
      expect(projection.messages).toHaveLength(1);

      await writeFile(
        path,
        `${JSON.stringify(header())}\n${"x".repeat(MAX_PERSISTED_ENTRY_BYTES + 1)}\n`,
      );
      await projection.reconcile(true);
      expect(projection.revision).toBe(revision);
      expect(projection.health.message).toMatch(/exceeds/);

      await writeFile(path, `${JSON.stringify(header("another-session"))}\n`);
      await projection.reconcile(true);
      expect(projection.revision).toBe(revision);
      expect(projection.health.message).toMatch(/another session/);
      expect(projection.messages[0]).toMatchObject({
        role: "user",
        content: "good",
      });
    } finally {
      await projection.close();
    }
  }, 15_000);
});

describe("SessionProjection replacement and Pi context semantics", () => {
  it("verifies the persisted prefix only once for a successful append candidate", async () => {
    let prefixChunks = 0;
    const hooks: SessionProjectionReadHooks = {
      afterPrefixReadChunk: () => {
        prefixChunks += 1;
      },
    };
    const { path, projection } = await fixture(
      [message("u1", null, "user", "one", 1)],
      "session-a",
      hooks,
    );
    try {
      prefixChunks = 0;
      await appendFile(
        path,
        `${JSON.stringify(message("a1", "u1", "assistant", "two", 2))}\n`,
      );
      expect(await projection.reconcile(true)).toMatchObject({
        changed: true,
        kind: "append",
      });
      expect(prefixChunks).toBe(1);
    } finally {
      await projection.close();
    }
  });

  it("reuses the verified hash and immutable projection prefix for an owned append", async () => {
    let prefixChunks = 0;
    const hooks: SessionProjectionReadHooks = {
      afterPrefixReadChunk: () => {
        prefixChunks += 1;
      },
    };
    const { path, projection } = await fixture(
      [message("u1", null, "user", "one", 1)],
      "session-a",
      hooks,
    );
    try {
      const firstProjectedMessage = projection.messages[0];
      projection.setOwnedAppendWindow(() => true);
      prefixChunks = 0;
      await appendFile(
        path,
        `${JSON.stringify(message("a1", "u1", "assistant", "two", 2))}\n`,
      );
      expect(await projection.reconcile(true)).toMatchObject({
        changed: true,
        kind: "append",
        messageChange: "append",
      });
      expect(prefixChunks).toBe(0);
      expect(projection.messages[0]).toBe(firstProjectedMessage);
      expect(projection.messages[1]).toMatchObject({
        role: "assistant",
        content: "two",
        __inspireUserTurnId: "u1:0",
        __inspireUserTurnIndex: 0,
      });
    } finally {
      await projection.close();
    }
  });

  it("keeps owned linear suffix projection equivalent to a fresh Pi context build", async () => {
    const { path, record, projection } = await fixture([
      message("u1", null, "user", "one", 1),
    ]);
    let fresh: SessionProjection | null = null;
    try {
      projection.setOwnedAppendWindow(() => true);
      const appended = [
        {
          type: "session_info",
          id: "info",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          name: "Named",
        },
        {
          type: "model_change",
          id: "model",
          parentId: "info",
          timestamp: "2026-08-01T00:00:03.000Z",
          provider: "test-provider",
          modelId: "test-model",
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          timestamp: "2026-08-01T00:00:04.000Z",
          thinkingLevel: "high",
        },
        {
          type: "custom_message",
          id: "custom",
          parentId: "thinking",
          timestamp: "2026-08-01T00:00:05.000Z",
          customType: "notice",
          content: "custom context",
          display: true,
        },
        {
          type: "branch_summary",
          id: "summary",
          parentId: "custom",
          timestamp: "2026-08-01T00:00:06.000Z",
          summary: "branch context",
          fromId: "u1",
        },
        {
          ...message("a1", "summary", "assistant", "two", 7),
          message: {
            role: "assistant",
            content: "two",
            timestamp: 7,
            provider: "answer-provider",
            model: "answer-model",
          },
        },
      ];
      await appendFile(
        path,
        `${appended.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      expect(await projection.reconcile(true)).toMatchObject({
        kind: "append",
        messageChange: "append",
      });

      fresh = await SessionProjection.open(record);
      expect(projection.messages).toEqual(fresh.messages);
      expect(projection.model).toEqual(fresh.model);
      expect(projection.thinkingLevel).toBe(fresh.thinkingLevel);
    } finally {
      await fresh?.close();
      await projection.close();
    }
  });

  it("uses one prefix pass plus the necessary full read for a grown rewrite", async () => {
    let prefixChunks = 0;
    let fullChunks = 0;
    const hooks: SessionProjectionReadHooks = {
      afterPrefixReadChunk: () => {
        prefixChunks += 1;
      },
      afterFullReadChunk: () => {
        fullChunks += 1;
      },
    };
    const { path, projection } = await fixture(
      [message("u1", null, "user", "old", 1)],
      "session-a",
      hooks,
    );
    try {
      prefixChunks = 0;
      fullChunks = 0;
      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "new and longer", 1))}\n`,
      );
      expect(await projection.reconcile(true)).toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      expect(prefixChunks).toBe(1);
      expect(fullChunks).toBe(1);
      expect(projection.messages[0]).toMatchObject({
        content: "new and longer",
      });
    } finally {
      await projection.close();
    }
  });

  it("retains the last-good projection for duplicate or cyclic entry identity", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    try {
      await appendFile(
        path,
        `${JSON.stringify(message("u1", "u1", "assistant", "duplicate", 2))}\n`,
      );
      await projection.reconcile(true);
      expect(projection.health).toMatchObject({
        status: "error",
        message: expect.stringMatching(/duplicate entry/i),
      });
      expect(projection.messages).toHaveLength(1);

      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", "u2", "user", "cycle one", 1))}\n${JSON.stringify(message("u2", "u1", "assistant", "cycle two", 2))}\n`,
      );
      await projection.reconcile(true);
      expect(projection.health).toMatchObject({
        status: "error",
        message: expect.stringMatching(/missing or forward parent/i),
      });
      expect(projection.messages[0]).toMatchObject({ content: "good" });
    } finally {
      await projection.close();
    }
  });

  it("detects forced missed-watch append, truncation, same-path rewrite, and atomic replacement", async () => {
    const { directory, path, projection } = await fixture([
      message("u1", null, "user", "one", 1),
    ]);
    try {
      await appendFile(
        path,
        `${JSON.stringify(message("a1", "u1", "assistant", "two", 2))}\n`,
      );
      const append = await projection.reconcile(true);
      expect(append).toMatchObject({ changed: true, kind: "append" });
      expect(projection.messages).toHaveLength(2);

      const sameSize = `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "ONE", 1))}\n`;
      await writeFile(path, sameSize);
      const rewrite = await projection.reconcile(true);
      expect(rewrite).toMatchObject({ changed: true, kind: "rewrite" });
      expect(projection.messages[0]).toMatchObject({ content: "ONE" });

      await truncate(path, Buffer.byteLength(JSON.stringify(header())) + 1);
      const truncation = await projection.reconcile(true);
      expect(truncation).toMatchObject({ changed: true, kind: "rewrite" });
      expect(projection.messages).toEqual([]);

      const replacement = join(directory, "replacement.jsonl");
      await writeFile(
        replacement,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u2", null, "user", "atomic", 3))}\n`,
      );
      await rename(replacement, path);
      const atomic = await projection.reconcile(true);
      expect(atomic).toMatchObject({ changed: true, kind: "rewrite" });
      expect(projection.messages[0]).toMatchObject({ content: "atomic" });
    } finally {
      await projection.close();
    }
  });

  it("retries a same-size same-inode rewrite that races a streamed full read instead of publishing a hybrid", async () => {
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hooks: SessionProjectionReadHooks = {
      async afterFullReadChunk() {
        if (!armed) return;
        armed = false;
        entered();
        await gate;
      },
    };
    const size = 2 * 1024 * 1024;
    const { path, projection } = await fixture(
      [message("u1", null, "user", "A".repeat(size), 1)],
      "session-a",
      hooks,
    );
    try {
      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "B".repeat(size), 1))}\n`,
      );
      armed = true;
      const reconciling = projection.reconcile(true);
      await reading;
      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "C".repeat(size), 1))}\n`,
      );
      release();
      await expect(reconciling).resolves.toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      const content = (projection.messages[0] as { content: string }).content;
      expect(content).toHaveLength(size);
      expect(/^C+$/u.test(content)).toBe(true);
      expect(projection.health.status).toBe("ok");
    } finally {
      release();
      await projection.close();
    }
  });

  it("retries a concurrently growing rewrite and publishes only the final coherent file", async () => {
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hooks: SessionProjectionReadHooks = {
      async afterFullReadChunk() {
        if (!armed) return;
        armed = false;
        entered();
        await gate;
      },
    };
    const size = 1024 * 1024;
    const { path, projection } = await fixture(
      [message("u1", null, "user", "A".repeat(size), 1)],
      "session-a",
      hooks,
    );
    try {
      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "B".repeat(size + 100), 1))}\n`,
      );
      armed = true;
      const reconciling = projection.reconcile(true);
      await reading;
      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("u1", null, "user", "C".repeat(size + 200), 1))}\n`,
      );
      release();
      await expect(reconciling).resolves.toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      const content = (projection.messages[0] as { content: string }).content;
      expect(content).toHaveLength(size + 200);
      expect(/^C+$/u.test(content)).toBe(true);
    } finally {
      release();
      await projection.close();
    }
  });

  it("follows an old-ancestor branch and applies compaction/tool-result semantics without modifying bytes", async () => {
    const lines = [
      message("u1", null, "user", "old root", 1),
      message(
        "a1",
        "u1",
        "assistant",
        [{ type: "text", text: "abandoned" }],
        2,
      ),
      message("u2", "a1", "user", "kept", 3),
      {
        type: "compaction",
        id: "c1",
        parentId: "u2",
        timestamp: "2026-08-01T00:00:04.000Z",
        summary: "summary of old work",
        firstKeptEntryId: "u2",
        tokensBefore: 1000,
      },
      message(
        "a2",
        "c1",
        "assistant",
        [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        5,
      ),
      message(
        "tr1",
        "a2",
        "toolResult",
        [{ type: "text", text: "tool output" }],
        6,
      ),
    ];
    const { path, bytes, projection } = await fixture(lines);
    try {
      const compacted = JSON.stringify(projection.messages);
      expect(compacted).toContain("summary of old work");
      expect(compacted).toContain("tool output");
      expect(compacted).not.toContain("abandoned");

      await appendFile(
        path,
        `${JSON.stringify(message("branch", "u1", "assistant", "new branch", 7))}\n`,
      );
      await projection.reconcile(true);
      const branched = JSON.stringify(projection.messages);
      expect(branched).toContain("old root");
      expect(branched).toContain("new branch");
      expect(branched).not.toContain("summary of old work");
      expect(branched).not.toContain("tool output");
      expect((await readFile(path, "utf8")).startsWith(bytes)).toBe(true);
    } finally {
      await projection.close();
    }
  });
});

describe("SessionProjection bounded paging", () => {
  it("projects and serializes each admitted message once", async () => {
    let projections = 0;
    const lines = Array.from({ length: 100 }, (_, index) =>
      message(
        `m${index}`,
        index ? `m${index - 1}` : null,
        index % 2 ? "assistant" : "user",
        `λ-${index}`,
        index + 1,
      ),
    );
    const { projection } = await fixture(lines, "session-a", {
      afterMessageProjection: () => {
        projections += 1;
      },
    });
    try {
      const page = projection.latestPage();
      expect(page.messages).toHaveLength(TRANSCRIPT_PAGE_MAX_MESSAGES);
      expect(projections).toBe(TRANSCRIPT_PAGE_MAX_MESSAGES);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        TRANSCRIPT_PAGE_MAX_BYTES,
      );
    } finally {
      await projection.close();
    }
  });

  it("projects more than 10 MiB of individually bounded history into count/byte bounded pages", async () => {
    const lines: unknown[] = [];
    let parent: string | null = null;
    for (let index = 0; index < 24; index += 1) {
      const id = `m${index}`;
      lines.push(
        message(
          id,
          parent,
          index % 2 ? "assistant" : "user",
          "z".repeat(480_000),
          index + 1,
        ),
      );
      parent = id;
    }
    const { path, projection } = await fixture(lines);
    try {
      expect((await readFile(path)).byteLength).toBeGreaterThan(
        10 * 1024 * 1024,
      );
      expect(projection.messages).toHaveLength(24);
      let page = projection.latestPage();
      expect(page.messages.length).toBeLessThanOrEqual(
        TRANSCRIPT_PAGE_MAX_MESSAGES,
      );
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        TRANSCRIPT_PAGE_MAX_BYTES,
      );
      const firstRevision = page.revision;
      let received = page.messages.length;
      while (page.hasOlder) {
        page = projection.page(page.olderCursor!);
        expect(page.revision).toBe(firstRevision);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          TRANSCRIPT_PAGE_MAX_BYTES,
        );
        received += page.messages.length;
      }
      expect(received).toBe(24);
    } finally {
      await projection.close();
    }
  }, 30_000);

  it("skips activity-only history during upward paging and materializes its opaque range on demand", async () => {
    const lines: unknown[] = [
      message("u0", null, "user", "old prompt", 1),
      message(
        "a0",
        "u0",
        "assistant",
        [{ type: "text", text: "old response" }],
        2,
      ),
    ];
    let parent = "a0";
    for (let index = 0; index < 120; index += 1) {
      const id = `activity-${index}`;
      lines.push(
        message(
          id,
          parent,
          index % 2 === 0 ? "assistant" : "toolResult",
          index % 2 === 0
            ? [{ type: "thinking", thinking: `thought ${index}` }]
            : `tool result ${index}`,
          index + 3,
        ),
      );
      parent = id;
    }
    const { projection } = await fixture(lines);
    try {
      const latest = projection.latestPage();
      expect(latest.messages).toHaveLength(TRANSCRIPT_PAGE_MAX_MESSAGES);
      const older = projection.visiblePage(latest.olderCursor!);
      expect(
        older.messages.map((value) => (value as { content?: unknown }).content),
      ).toEqual(["old prompt", [{ type: "text", text: "old response" }]]);
      expect(older.hasOlder).toBe(false);
      expect(older.activityRanges).toHaveLength(1);
      const range = older.activityRanges![0]!;
      expect(range).toMatchObject({
        messageCount: 20,
        kinds: ["thinking", "tool"],
      });
      expect(range.afterMessageId).toBe(
        (older.messages[1] as { __inspireMessageId?: string })
          .__inspireMessageId,
      );

      const materialized: unknown[] = [];
      let cursor: string | null = range.cursor;
      while (cursor) {
        const page = projection.activityPage(cursor);
        materialized.unshift(...page.messages);
        cursor = page.hasMore ? page.cursor : null;
      }
      expect(materialized).toHaveLength(20);
      expect((materialized[0] as { content?: unknown }).content).toEqual([
        { type: "thinking", thinking: "thought 0" },
      ]);
      expect((materialized.at(-1) as { content?: unknown }).content).toBe(
        "tool result 19",
      );
      expect(() => projection.page(range.cursor)).toThrow(/wrong purpose/);
    } finally {
      await projection.close();
    }
  });

  it("does not advertise context-only custom history as deferred visible activity", async () => {
    const lines: unknown[] = [message("u0", null, "user", "prompt", 1)];
    let parent = "u0";
    for (let index = 0; index < 120; index += 1) {
      const id = `custom-${index}`;
      lines.push({
        ...message(id, parent, "custom", "private context", index + 2),
        message: {
          role: "custom",
          content: "private context",
          display: false,
          timestamp: index + 2,
        },
      });
      parent = id;
    }
    const { projection } = await fixture(lines);
    try {
      const latest = projection.latestPage();
      const older = projection.visiblePage(latest.olderCursor!);
      expect(older.messages).toHaveLength(1);
      expect(older.activityRanges).toBeUndefined();
      expect(older.hasOlder).toBe(false);
    } finally {
      await projection.close();
    }
  });

  it("indexes current-branch user turns and seeks directly to a response-oriented target window", async () => {
    const lines: unknown[] = [];
    let parent: string | null = null;
    for (let turn = 0; turn < 140; turn += 1) {
      const userId = `u${turn}`;
      const assistantId = `a${turn}`;
      lines.push(
        message(userId, parent, "user", `prompt ${turn}`, turn * 10 + 1),
      );
      lines.push(
        message(
          assistantId,
          userId,
          "assistant",
          [{ type: "text", text: `response ${turn}` }],
          turn * 10 + 2,
        ),
      );
      parent = assistantId;
      if (turn === 3) {
        for (let activity = 0; activity < 80; activity += 1) {
          const id = `activity-${activity}`;
          lines.push(
            message(
              id,
              parent,
              "assistant",
              [{ type: "thinking", thinking: `hidden ${activity}` }],
              turn * 10 + 3 + activity,
            ),
          );
          parent = id;
        }
        for (let response = 0; response < 170; response += 1) {
          const id = `continued-response-${response}`;
          lines.push(
            message(
              id,
              parent,
              "assistant",
              [{ type: "text", text: `continued ${response}` }],
              turn * 10 + 100 + response,
            ),
          );
          parent = id;
        }
      }
    }
    const { path, projection } = await fixture(lines);
    try {
      const latestTurns = projection.userTurnIndexPage(
        undefined,
        projection.leafId,
        "view-a",
      );
      expect(latestTurns.total).toBe(140);
      expect(latestTurns.start).toBe(40);
      expect(latestTurns.turns[0]).toMatchObject({
        ordinal: 40,
        snippet: "prompt 40",
      });
      expect(latestTurns.turns.at(-1)).toMatchObject({ ordinal: 139 });

      await appendFile(
        path,
        `${JSON.stringify(
          message("user-140", parent, "user", "prompt 140", 9_000),
        )}\n`,
      );
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        messageChange: "append",
      });
      expect(
        projection.userTurnIndexPage(undefined, projection.leafId, "view-a"),
      ).toMatchObject({
        total: 141,
        turns: expect.arrayContaining([
          expect.objectContaining({ ordinal: 140, snippet: "prompt 140" }),
        ]),
      });

      const firstTurns = projection.userTurnIndexPage(
        0,
        projection.leafId,
        "view-a",
      );
      const target = firstTurns.turns[3]!;
      const page = projection.userTurnTranscriptPage(
        target.id,
        projection.leafId,
        "view-a",
      );
      expect(page.targetMessageId).toBe(target.id);
      expect(page.hasOlder).toBe(true);
      expect(page.olderCursor).toBeTruthy();
      expect(
        projection.page(page.olderCursor!, projection.leafId, "view-a").messages
          .length,
      ).toBeGreaterThan(0);
      expect(
        page.messages.some((value) =>
          JSON.stringify(value).includes("hidden 0"),
        ),
      ).toBe(false);
      expect(page.activityRanges?.length).toBeGreaterThan(0);
      expect(page.hasMoreInTurn).toBe(true);
      expect(page.continuationCursor).toBeTruthy();
      const continuation = projection.userTurnTranscriptPage(
        target.id,
        projection.leafId,
        "view-a",
        page.continuationCursor!,
      );
      expect(continuation.rangeStart).toBe(page.rangeStart);
      expect(continuation.rangeEnd).toBeGreaterThan(page.rangeEnd);
      expect(() => projection.page(page.continuationCursor!)).toThrow(
        /wrong purpose/,
      );
      const annotatedUser = page.messages.find(
        (value) =>
          (value as { __inspireMessageId?: string }).__inspireMessageId ===
          target.id,
      ) as { __inspireUserTurnIndex?: number; __inspireUserTurnId?: string };
      expect(annotatedUser).toMatchObject({
        __inspireUserTurnIndex: 3,
        __inspireUserTurnId: target.id,
      });
      expect(() =>
        projection.userTurnTranscriptPage(
          "not-a-turn",
          projection.leafId,
          "view-a",
        ),
      ).toThrow(/does not exist/);
    } finally {
      await projection.close();
    }
  });

  it("binds the prompt outline and direct seek to the selected branch view", async () => {
    const { projection } = await fixture([
      message("u-root", null, "user", "root prompt", 1),
      message("a-root", "u-root", "assistant", "root response", 2),
      message("u-main", "a-root", "user", "main prompt", 3),
      message("a-main", "u-main", "assistant", "main response", 4),
      message("u-alt", "a-root", "user", "alternate prompt", 5),
      message("a-alt", "u-alt", "assistant", "alternate response", 6),
    ]);
    try {
      const mainTurns = projection.userTurnIndexPage(
        0,
        "a-main",
        "view-main",
      ).turns;
      expect(mainTurns.map((turn) => turn.snippet)).toEqual([
        "root prompt",
        "main prompt",
      ]);
      expect(
        projection
          .userTurnIndexPage(0, "a-alt", "view-alt")
          .turns.map((turn) => turn.snippet),
      ).toEqual(["root prompt", "alternate prompt"]);

      const mainTurnId = mainTurns[1]!.id;
      const main = projection.userTurnTranscriptPage(
        mainTurnId,
        "a-main",
        "view-main",
      );
      expect(JSON.stringify(main.messages)).toContain("main response");
      expect(JSON.stringify(main.messages)).not.toContain("alternate prompt");
      expect(() =>
        projection.userTurnTranscriptPage(mainTurnId, "a-alt", "view-alt"),
      ).toThrow(/does not exist/);
    } finally {
      await projection.close();
    }
  });

  it("keeps cursors across projected message appends and invalidates them when an appended compaction replaces the view", async () => {
    const lines = Array.from({ length: 120 }, (_, index) =>
      message(
        `m${index}`,
        index ? `m${index - 1}` : null,
        index % 2 ? "assistant" : "user",
        `message ${index}`,
        index + 1,
      ),
    );
    const { path, projection } = await fixture(lines);
    try {
      const latest = projection.latestPage([], projection.leafId, "view-a");
      const cursor = latest.olderCursor!;
      const appendedMessage = message(
        "m120",
        "m119",
        "assistant",
        "continued",
        121,
      );
      await appendFile(path, `${JSON.stringify(appendedMessage)}\n`);
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        kind: "append",
        messageChange: "append",
      });
      expect(
        projection.page(cursor, projection.leafId, "view-a").messages.length,
      ).toBeGreaterThan(0);

      await appendFile(
        path,
        `${JSON.stringify({
          type: "compaction",
          id: "compact",
          parentId: "m120",
          timestamp: "2026-08-01T00:03:00.000Z",
          summary: "compacted history",
          firstKeptEntryId: "m116",
          tokensBefore: 1_000,
        })}\n`,
      );
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        kind: "append",
        messageChange: "replace",
      });
      expect(() =>
        projection.page(cursor, projection.leafId, "view-a"),
      ).toThrow(/stale/);
    } finally {
      await projection.close();
    }
  });

  it("rejects a cursor from an evicted and reopened projection incarnation", async () => {
    const { record, projection } = await fixture(
      Array.from({ length: 120 }, (_, index) =>
        message(
          `m${index}`,
          index ? `m${index - 1}` : null,
          "user",
          `m${index}`,
          index + 1,
        ),
      ),
    );
    const cursor = projection.latestPage().olderCursor!;
    await projection.close();
    const reopened = await SessionProjection.open(record);
    try {
      expect(() => reopened.page(cursor)).toThrow(
        /expired projection incarnation/,
      );
    } finally {
      await reopened.close();
    }
  });

  it("keeps equal-timestamp tool results distinct across page boundaries", async () => {
    const lines = Array.from({ length: 120 }, (_, index) => ({
      ...message(
        `tr${index}`,
        index ? `tr${index - 1}` : null,
        "toolResult",
        `result-${index}`,
        1,
      ),
      message: {
        role: "toolResult",
        content: `result-${index}`,
        timestamp: 1,
        toolCallId: `call-${index}`,
        toolName: "read",
      },
    }));
    const { projection } = await fixture(lines);
    try {
      const ids: string[] = [];
      const entryIds: string[] = [];
      let page = projection.latestPage();
      while (true) {
        ids.push(
          ...page.messages.map((value) =>
            String((value as Record<string, unknown>).__inspireMessageId),
          ),
        );
        entryIds.push(
          ...page.messages.map((value) =>
            String((value as Record<string, unknown>).__inspireEntryId),
          ),
        );
        if (!page.hasOlder) break;
        page = projection.page(page.olderCursor!);
      }
      expect(ids).toHaveLength(120);
      expect(new Set(ids).size).toBe(120);
      expect(entryIds).toEqual(ids.map((id) => id.replace(/:0$/, "")));
    } finally {
      await projection.close();
    }
  });

  it("binds cursors to session, incarnation, content lineage, and revision and emits parent-watch update hints", async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      message(
        `m${index}`,
        index ? `m${index - 1}` : null,
        "user",
        index === 0
          ? [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
          : `m${index}`,
        index + 1,
      ),
    );
    const { path, projection } = await fixture(many);
    try {
      const latest = projection.latestPage();
      expect(latest.hasOlder).toBe(true);
      const cursor = latest.olderCursor!;
      const viewBound = projection.latestPage([], projection.leafId, "view-a")
        .olderCursor!;
      expect(() =>
        projection.page(viewBound, projection.leafId, "view-b"),
      ).toThrow(/another branch view/);
      let oldest = latest;
      while (oldest.hasOlder) oldest = projection.page(oldest.olderCursor!);
      expect(
        collectSessionResourceReferences(oldest.messages)[0]?.reference,
      ).toBe("pi-embedded://0/0");
      const updated = vi.fn();
      projection.on("update", updated);
      await appendFile(
        path,
        `${JSON.stringify(message("last", "m119", "assistant", "watched", 200))}\n`,
      );
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), {
        timeout: 2_000,
      });
      expect(projection.messages.at(-1)).toMatchObject({ role: "assistant" });
      expect(projection.page(cursor).revision).toBe(latest.revision + 1);

      await writeFile(
        path,
        `${JSON.stringify(header())}\n${JSON.stringify(message("replacement", null, "user", "rewrite", 300))}\n`,
      );
      await projection.reconcile(true);
      expect(() => projection.page(cursor)).toThrow(/stale/);
    } finally {
      await projection.close();
    }
  });
});
