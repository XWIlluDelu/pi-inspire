import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../server/session-catalog.js";
import { JsonlObjectDecoder } from "../../server/session-jsonl.js";
import {
  boundedTranscriptValue,
  MAX_PERSISTED_ENTRY_BYTES,
  SessionProjection,
  type SessionProjectionReadHooks,
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSCRIPT_PAGE_MAX_MESSAGES,
} from "../../server/session-projection.js";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context.js";
import { collectSessionResourceReferences } from "../../shared/resource-references.js";
import { deferredSignal } from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const directories: string[] = [];
const projections: SessionProjection[] = [];

async function openProjection(
  ...args: Parameters<typeof SessionProjection.open>
) {
  const projection = await SessionProjection.open(...args);
  projections.push(projection);
  return projection;
}
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
  fields: Record<string, unknown> = {},
) => messageEntry(id, parentId, { role, content, timestamp, ...fields });

async function fixture(
  lines: unknown[],
  id = "session-a",
  readHooks?: SessionProjectionReadHooks,
  fileNameForPath?: (path: string) => string | null,
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-projection-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const bytes = jsonl(header(id), ...lines);
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
  };
  return {
    directory,
    path,
    bytes,
    record,
    projection: await openProjection(record, readHooks, fileNameForPath),
  };
}

afterEach(async () => {
  try {
    await Promise.all(
      projections.splice(0).map((projection) => projection.close()),
    );
  } finally {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

describe("SessionProjection framing and last-good state", () => {
  it("owns an unfinished frame when the caller reuses its read buffer", () => {
    const frames: Buffer[] = [];
    const decoder = new JsonlObjectDecoder((frame) => {
      frames.push(Buffer.from(frame));
    });
    const buffer = Buffer.alloc(16);

    let length = buffer.write('{"value"');
    expect(decoder.push(buffer.subarray(0, length))).toEqual([]);

    length = buffer.write(':"ok"}\n');
    expect(decoder.push(buffer.subarray(0, length))).toEqual([{ value: "ok" }]);
    expect(Buffer.concat(frames).toString("utf8")).toBe('{"value":"ok"}\n');
  });

  it("reads legacy session entries without modifying their JSONL bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "inspire-projection-legacy-"));
    directories.push(cwd);
    const path = join(cwd, "legacy.jsonl");
    const id = "legacy";
    const timestamp = new Date(0);
    const original =
      [
        { type: "session", id, cwd, timestamp },
        {
          type: "message",
          timestamp,
          message: { role: "user", content: "legacy", timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";
    await writeFile(path, original);
    const projection = await openProjection({
      id,
      cwd,
      path,
      source: null,
      created: timestamp,
      modified: timestamp,
      messageCount: 1,
      firstMessage: "legacy",
    });
    expect(projection.latestPage().messages).toMatchObject([
      { role: "user", content: "legacy" },
    ]);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("finds the latest saved continuation independently for interleaved sibling branches", async () => {
    const { projection } = await fixture([
      message("root", null, "user", "root", 1),
      message("left", "root", "assistant", "left", 2),
      message("right", "root", "assistant", "right", 3),
      message("left-first", "left", "user", "first left continuation", 6),
      message("right-end", "right", "user", "right continuation", 7),
      message("left-end", "left", "user", "last saved left continuation", 4),
    ]);
    expect(projection.latestContinuation("left")).toBe("left-end");
    expect(projection.latestContinuation("right")).toBe("right-end");
    expect(projection.latestContinuation("right-end")).toBe("right-end");
    expect(projection.latestContinuation("root")).toBe("left-end");
    expect(projection.latestContinuation(null)).toBe("left-end");
    expect(projection.latestContinuation("missing")).toBe("missing");
  });

  it("does not turn an unknown parent outcome into success when projecting failed child receipts", () => {
    const result = {
      role: "toolResult",
      toolName: "codemode",
      content: "Parent output",
      details: {
        calls: [
          {
            id: "script/1",
            name: "read",
            args: '{"path":"a.txt"}',
            status: "error",
          },
        ],
      },
    };
    expect(boundedTranscriptValue(result)).not.toHaveProperty("isError");
    for (const isError of [true, false])
      expect(boundedTranscriptValue({ ...result, isError })).toMatchObject({
        isError,
        __inspireCalls: { calls: [{ status: "error" }] },
      });
  });
  it("projects mixed attachments for transcript and History while retaining the original input", async () => {
    const caption = "Keep the literal [Image: image/png] text.";
    const reference = "/demo/report.csv";
    const text = `${caption}\n\n${ATTACHMENT_CONTEXT_HEADING}\n- ${JSON.stringify(reference)}\n\n[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]`;
    const name = "研究".repeat(50) + ".csv";
    const data = Buffer.alloc(512 * 1024, 7).toString("base64");
    const image = { type: "image", mimeType: "image/png" };
    const other = { type: "image", mimeType: "image/webp" };
    const { projection, path, bytes } = await fixture(
      [
        message(
          "mixed-input",
          null,
          "user",
          [
            { type: "text", text },
            { ...image, data },
            { ...other, data: "different" },
          ],
          1,
        ),
        message("answer", "mixed-input", "assistant", "Answer", 2),
      ],
      "session-a",
      undefined,
      (file) => (file === reference ? name : null),
    );
    const page = projection.latestPage();
    const projected = page.messages[0];
    expect(projected).toMatchObject({
      __inspireMessageIndex: 0,
      __inspireFileNames: { [reference]: name },
    });
    expect((projected as { content: unknown }).content).toEqual([
      { type: "text", text },
      image,
      other,
    ]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      TRANSCRIPT_PAGE_MAX_BYTES,
    );
    expect(
      collectSessionResourceReferences([projected])
        .map((item) => item.reference)
        .filter((reference) => reference?.startsWith("pi-embedded:")),
    ).toEqual(["pi-embedded://0/2", "pi-embedded://0/1"]);
    expect(
      projection.branchEntry("mixed-input", 0, "mixed-input"),
    ).toMatchObject({
      text,
      totalChars: text.length,
      nextOffset: null,
      images: [
        { index: 1, mimeType: "image/png" },
        { index: 2, mimeType: "image/webp" },
      ],
    });
    expect(projection.branchTree("mixed-input").nodes[0]?.snippet).toBe(
      `${caption} report.csv [Image: image/png] [Image: image/webp]`,
    );
    expect(
      projection.branchTree("mixed-input", { query: reference }).nodes[0]
        ?.snippet,
    ).toContain(reference);
    expect(projection.userText("mixed-input", text.length)).toBe(text);
    expect(() => projection.userText("mixed-input", 3)).toThrow(
      /composer limit/,
    );
    expect(() => projection.userText("answer", 100)).toThrow(
      /not an editable user/,
    );
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("invalidates composer history on user append, branch change, and same-ID rewrite", async () => {
    const first = message("u1", null, "user", "first", 1);
    const { path, projection } = await fixture([first]);
    const original = projection.latestPage().composerHistoryVersion;
    const second = message("u2", "u1", "user", "second", 2);
    await appendFile(path, `${JSON.stringify(second)}\n`);
    await projection.reconcile(true);
    const appended = projection.latestPage().composerHistoryVersion;
    expect(appended).not.toBe(original);
    expect(projection.composerHistoryPage().composerHistoryVersion).toBe(
      appended,
    );
    expect(projection.latestPage([], "u1").composerHistoryVersion).toBe(
      original,
    );

    const branch = message("u3", "u1", "user", "alternate", 3);
    await appendFile(path, `${JSON.stringify(branch)}\n`);
    await projection.reconcile(true);
    const branched = projection.latestPage().composerHistoryVersion;
    expect(branched).not.toBe(appended);
    expect(
      projection.composerHistoryPage().entries.map((entry) => entry.text),
    ).toEqual(["alternate", "first"]);

    await writeFile(
      path,
      `${[header(), { ...first, message: { ...first.message, content: "rewritten" } }, second, branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await projection.reconcile(true);
    expect(projection.latestPage().composerHistoryVersion).not.toBe(branched);
    expect(projection.latestPage([], "u1").composerHistoryVersion).not.toBe(
      original,
    );
    expect(
      projection.composerHistoryPage().entries.map((entry) => entry.text),
    ).toEqual(["alternate", "rewritten"]);
  });

  it("accepts only working-directory aliases for the catalogued project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-projection-cwd-"));
    directories.push(directory);
    const alias = join(directory, "alias");
    const other = join(directory, "other");
    await mkdir(other);
    await symlink(directory, alias, "junction");
    const path = join(directory, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ ...header(), cwd: directory })}\n`,
    );
    const record: SessionRecord = {
      id: "session-a",
      path,
      source: null,
      cwd: alias,
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
    };

    const projection = await SessionProjection.openPending(record);
    expect(projection.attestInitialMaterialization([])).toBe("complete");
    await projection.close();
    await expect(
      SessionProjection.openPending({ ...record, cwd: other }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("permits an absent session file only while a new session materializes", async () => {
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
    };
    await expect(SessionProjection.open(record)).rejects.toThrow(
      /ENOENT|no such file/i,
    );
    const projection = await SessionProjection.openPending(record);
    await projection.suspendReconciliation();
    try {
      expect(projection).toMatchObject({
        sourceIdentity: null,
        health: { status: "ok" },
      });
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: false,
        sourceChanged: false,
      });

      const firstHeader = JSON.stringify(header(record.id));
      await writeFile(path, firstHeader.slice(0, -1));
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: false,
        sourceChanged: true,
        committedBytes: 0,
        uncommittedBytes: Buffer.byteLength(firstHeader) - 1,
        health: { status: "pending" },
      });
      expect(projection.attestInitialMaterialization([])).toBe("partial");

      const entries = [
        {
          type: "model_change",
          id: "model-1",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          provider: "test",
          modelId: "model",
        },
        {
          type: "thinking_level_change",
          id: "thinking-1",
          parentId: "model-1",
          timestamp: "2026-08-01T00:00:02.000Z",
          thinkingLevel: "medium",
        },
      ] as const;
      await appendFile(
        path,
        `${firstHeader.slice(-1)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: true,
        kind: "append",
        previousTailVerified: true,
        appendedEntries: entries,
        previousLeafId: null,
        uncommittedBytes: 0,
        health: { status: "ok" },
      });
      expect(projection.attestInitialMaterialization(entries)).toBe("complete");
    } finally {
      projection.resumeReconciliation();
      await projection.close();
    }
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

  it("retains message identity and outcome under object and content budgets", () => {
    const dense = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `field-${index}`,
        "x".repeat(4_000),
      ]),
    );
    const identity = {
      __inspireMessageId: "entry-id:0",
      __inspireEntryId: "entry-id",
      __inspireLiveId: "live-id",
      __inspireSettled: false,
    };
    expect(
      boundedTranscriptValue({
        ...dense,
        ...identity,
        role: "assistant",
        stopReason: "error",
        errorMessage: "WebSocket error",
      }),
    ).toMatchObject({
      ...identity,
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket error",
    });

    const content = Array.from({ length: 64 }, () => ({
      type: "toolCall",
      ...dense,
    }));
    const outcome = { stopReason: "aborted", errorMessage: "interrupted" };
    for (const attributes of [{}, outcome]) {
      const projected = boundedTranscriptValue({
        ...identity,
        role: "assistant",
        content,
        ...attributes,
      });
      expect(projected).toMatchObject({ ...identity, ...attributes });
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
        256 * 1024,
      );
      if (attributes === outcome) {
        expect(projected).toMatchObject({
          content: expect.stringContaining("message omitted"),
        });
      } else {
        expect(projected).toMatchObject({
          content: [{ type: "projectionOmitted" }],
        });
      }
    }
  });

  it("withholds a split UTF-8 line and verifies its completed tail when LF arrives", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    const revision = projection.revision;
    const sourceVersion = projection.sourceVersion;
    const text = "完整";
    const next = Buffer.from(
      JSON.stringify(message("a1", "u1", "assistant", text, 2)),
    );
    const splitAt = next.indexOf(Buffer.from(text)) + 1;
    await appendFile(path, next.subarray(0, splitAt));
    const partial = await projection.reconcile(true);
    expect(partial).toMatchObject({
      changed: false,
      sourceChanged: true,
      previousUncommittedBytes: 0,
      uncommittedBytes: splitAt,
    });
    expect(projection.revision).toBe(revision);
    expect(projection.sourceVersion).not.toBe(sourceVersion);
    expect(projection.messages).toHaveLength(1);

    await appendFile(
      path,
      Buffer.concat([next.subarray(splitAt), Buffer.from("\n")]),
    );
    await expect(projection.reconcile(true)).resolves.toMatchObject({
      changed: true,
      kind: "append",
      uncommittedBytes: 0,
      previousTailVerified: true,
    });
    expect(projection.messages.at(-1)).toMatchObject({ content: text });
  });

  it("surfaces truncation or replacement of an unresolved tail instead of treating it as completion", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    await projection.suspendReconciliation();
    try {
      const committed = projection.committedBytes;
      await appendFile(path, '{"type":"message"');
      await projection.reconcileSuspended(true);
      expect(projection.uncommittedBytes).toBeGreaterThan(0);

      await truncate(path, committed);
      const truncated = await projection.reconcileSuspended(true);
      expect(truncated).toMatchObject({
        changed: false,
        sourceChanged: true,
        uncommittedBytes: 0,
        previousTailVerified: false,
      });

      await appendFile(path, "partial-a");
      await projection.reconcileSuspended(true);
      await writeFile(
        path,
        `${(await readFile(path)).subarray(0, committed).toString()}partial-b`,
      );
      const rewritten = await projection.reconcileSuspended(true);
      expect(rewritten).toMatchObject({
        sourceChanged: true,
        previousTailVerified: false,
      });
    } finally {
      projection.resumeReconciliation();
      await projection.close();
    }
  });

  it("drains an active file read on close and rejects its queued successor", async () => {
    const entered = deferredSignal();
    const release = deferredSignal();
    let pause = false;
    const { path, projection } = await fixture(
      [message("u1", null, "user", "good", 1)],
      "session-a",
      {
        async afterFullReadChunk() {
          if (!pause) return;
          pause = false;
          entered.resolve();
          await release.promise;
        },
      },
    );
    await projection.suspendReconciliation();
    try {
      await writeFile(
        path,
        jsonl(header(), message("u1", null, "user", "edited", 1)),
      );
      pause = true;
      const reading = projection.reconcileSuspended(true);
      await entered.promise;
      const rejected = expect(
        projection.reconcileSuspended(true),
      ).rejects.toThrow(/closed/);
      let closed = false;
      const closing = projection.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release.resolve();
      await Promise.all([reading, closing, rejected]);
    } finally {
      release.resolve();
      await projection.close();
    }
  });

  // This intentionally streams a 32 MiB + 1 byte adversarial entry. It has
  // no external dependency, but may legitimately exceed Vitest's 5s default
  // when the full server suite is CPU- and I/O-contended in CI.
  it("keeps the last good projection when bad bytes or entry identities reach disk", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    const revision = projection.revision;
    await appendFile(path, "{malformed}\n");
    await projection.reconcile(true);
    expect(projection.health).toMatchObject({
      status: "error",
      message: expect.stringMatching(/malformed/),
    });
    expect(projection.revision).toBe(revision);
    expect(projection.messages).toMatchObject([
      { role: "user", content: "good" },
    ]);

    const replacements = [
      [
        `${jsonl(header())}${"x".repeat(MAX_PERSISTED_ENTRY_BYTES + 1)}\n`,
        /exceeds/,
      ],
      [jsonl(header("another-session")), /another session/],
      [
        jsonl(
          header(),
          message("u1", null, "user", "first", 1),
          message("u1", "u1", "assistant", "duplicate", 2),
        ),
        /duplicate entry/i,
      ],
      [
        jsonl(header(), message("u1", "missing", "user", "orphan", 1)),
        /missing or forward parent/i,
      ],
      [
        jsonl(
          header(),
          message("u1", "u2", "user", "cycle one", 1),
          message("u2", "u1", "assistant", "cycle two", 2),
        ),
        /missing or forward parent/i,
      ],
    ] as const;
    for (const [bytes, error] of replacements) {
      await writeFile(path, bytes);
      await projection.reconcile(true);
      expect(projection.health).toMatchObject({
        status: "error",
        message: expect.stringMatching(error),
      });
      expect(projection.revision).toBe(revision);
      expect(projection.messages).toMatchObject([
        { role: "user", content: "good" },
      ]);
    }

    await writeFile(
      path,
      jsonl(header(), message("u1", null, "user", "repaired", 1)),
    );
    await projection.reconcile(true);
    expect(projection.health.status).toBe("ok");
    expect(projection.messages).toMatchObject([
      { role: "user", content: "repaired" },
    ]);
  }, 15_000);
});

describe("SessionProjection replacement and Pi context semantics", () => {
  it("keeps owned linear suffix projection equivalent to a fresh Pi context build", async () => {
    const { path, record, projection } = await fixture([
      message("s1", null, "system", "host-only startup", 0),
      message("u1", "s1", "user", "one", 1),
    ]);
    const prefix = projection.messages[0];
    let fresh: SessionProjection | null = null;
    try {
      expect(projection.viewMessages("s1")).toEqual([]);
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
        message("s2", "a1", "system", "host-only update", 8),
      ];
      await appendFile(
        path,
        `${appended.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      expect(await projection.reconcile(true)).toMatchObject({
        kind: "append",
        messageChange: "append",
      });

      expect(projection.messages[0]).toBe(prefix);
      expect(projection.leafId).toBe("s2");
      expect(projection.viewMessages("s2")).toEqual(projection.messages);
      expect(JSON.stringify(projection.latestPage())).not.toContain(
        "host-only",
      );
      fresh = await SessionProjection.open(record);
      expect(projection.messages).toEqual(fresh.messages);
      expect(projection.model).toEqual(fresh.model);
      expect(projection.thinkingLevel).toBe(fresh.thinkingLevel);
    } finally {
      await fresh?.close();
      await projection.close();
    }
  });

  it("recovers a healthy projection on the next ordinary read after a verification failure", async () => {
    const { projection } = await fixture([
      message("u1", null, "user", "one", 1),
    ]);
    await projection.suspendReconciliation();
    try {
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: false,
        verifiedUnchangedContent: true,
      });

      vi.mocked(open).mockRejectedValueOnce(
        new Error("temporary read failure"),
      );
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        health: { status: "error" },
      });
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        changed: false,
        healthChanged: true,
        health: { status: "ok" },
      });
    } finally {
      projection.resumeReconciliation();
      await projection.close();
    }
  });

  it("detects append, same-size edits and source replacement without a watch notification", async () => {
    const first = message("u1", null, "user", "one", 1);
    const second = message("a1", "u1", "assistant", "two", 2);
    const { directory, path, projection } = await fixture([first]);
    await projection.suspendReconciliation();
    try {
      await appendFile(path, `${JSON.stringify(second)}\n`);
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: true,
        kind: "append",
      });
      expect(projection.messages).toHaveLength(2);

      const before = await stat(path);
      const edited = message("u1", null, "user", "ONE", 1);
      await writeFile(path, jsonl(header(), edited, second));
      await utimes(path, before.atime, before.mtime);
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      expect(projection.messages[0]).toMatchObject({ content: "ONE" });

      const third = message("u2", "a1", "user", "three", 3);
      await writeFile(path, jsonl(header(), first, second, third));
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      expect(
        projection.messages.map(
          (entry) => (entry as { content: unknown }).content,
        ),
      ).toEqual(["one", "two", "three"]);

      const replacement = join(directory, "replacement.jsonl");
      await writeFile(replacement, await readFile(path));
      await rename(replacement, path);
      const atomic = await projection.reconcileSuspended();
      expect(atomic).toMatchObject({ changed: false, sourceChanged: true });
      expect(atomic.verifiedUnchangedContent).toBeUndefined();

      await truncate(path, Buffer.byteLength(jsonl(header())));
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: true,
        kind: "rewrite",
      });
      expect(projection.messages).toEqual([]);
    } finally {
      projection.resumeReconciliation();
      await projection.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink that replaces the opened JSONL, even when it points to its former inode",
    async () => {
      const { directory, path, projection } = await fixture([
        message("u1", null, "user", "one", 1),
      ]);
      await projection.suspendReconciliation();
      try {
        const retained = join(directory, "retained.jsonl");
        await rename(path, retained);
        await symlink(retained, path);
        await expect(projection.reconcileSuspended()).resolves.toMatchObject({
          changed: false,
          health: { status: "error" },
        });
        expect(projection.messages[0]).toMatchObject({ content: "one" });
      } finally {
        projection.resumeReconciliation();
        await projection.close();
      }
    },
  );

  it("publishes coherent bytes when a streamed read races a same-size rewrite", async () => {
    const entered = deferredSignal();
    const release = deferredSignal();
    let pause = false;
    const size = 256 * 1024;
    const entry = (text: string) => message("u1", null, "user", text, 1);
    const { path, projection } = await fixture(
      [entry("A".repeat(size))],
      "session-a",
      {
        async afterFullReadChunk() {
          if (!pause) return;
          pause = false;
          entered.resolve();
          await release.promise;
        },
      },
    );
    await projection.suspendReconciliation();
    try {
      await writeFile(path, jsonl(header(), entry("B".repeat(size))));
      pause = true;
      const reconciling = projection.reconcileSuspended(true);
      await entered.promise;
      const content = "C".repeat(size);
      await writeFile(path, jsonl(header(), entry(content)));
      release.resolve();
      await expect(reconciling).resolves.toMatchObject({
        kind: "rewrite",
        health: { status: "ok" },
      });
      expect(projection.messages[0]).toMatchObject({ content });
    } finally {
      release.resolve();
      projection.resumeReconciliation();
      await projection.close();
    }
  });
});

describe("SessionProjection bounded paging", () => {
  it("pages more than 10 MiB of history within the transcript byte budget", async () => {
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
    const { projection } = await fixture(lines);
    let page = projection.latestPage();
    const firstRevision = page.revision;
    const received: unknown[] = [];
    expect(page.hasOlder).toBe(true);
    for (;;) {
      expect(page.revision).toBe(firstRevision);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        TRANSCRIPT_PAGE_MAX_BYTES,
      );
      received.unshift(...page.messages);
      if (!page.hasOlder) break;
      page = projection.visiblePage(page.olderCursor!);
    }
    expect(received).toMatchObject(
      Array.from({ length: 24 }, (_, index) => ({
        __inspireEntryId: `m${index}`,
      })),
    );
  }, 30_000);

  it("defers only activity in reopened history and materializes paired calls once", async () => {
    const call = {
      type: "toolCall",
      id: "read-call",
      name: "read",
      arguments: {},
    };
    const lines = [
      message("u1", null, "user", "inspect activity", 1),
      message("a1", "u1", "assistant", "old response", 2),
      message("tool", "a1", "assistant", [call], 3),
      message("result", "tool", "toolResult", "done", 4, {
        toolCallId: call.id,
      }),
      message(
        "thought",
        "result",
        "assistant",
        [{ type: "thinking", thinking: "planning" }],
        5,
      ),
      message("error", "thought", "assistant", [], 6, {
        stopReason: "error",
        errorMessage: "fetch failed",
      }),
      message(
        "aborted",
        "error",
        "assistant",
        [{ type: "thinking", thinking: "partial" }],
        7,
        {
          stopReason: "aborted",
          errorMessage: "interrupted",
        },
      ),
      {
        type: "custom_message",
        id: "review",
        parentId: "aborted",
        timestamp: new Date(8).toISOString(),
        customType: "review",
        content: "Visible extension review",
        details: { source: "extension" },
        display: true,
      },
      message("private", "review", "custom", "private context", 9, {
        display: false,
      }),
      ...Array.from({ length: TRANSCRIPT_PAGE_MAX_MESSAGES }, (_, index) =>
        message(
          `tail-${index}`,
          index ? `tail-${index - 1}` : "private",
          "assistant",
          "answer",
          index + 100,
        ),
      ),
    ];
    const { projection, record } = await fixture(lines);
    await projection.close();
    const reopened = await SessionProjection.open(record);
    try {
      const older = reopened.visiblePage(reopened.latestPage().olderCursor!);
      const visible = [
        { content: "inspect activity" },
        { content: "old response" },
        { stopReason: "error", errorMessage: "fetch failed" },
        { stopReason: "aborted", errorMessage: "interrupted" },
        {
          role: "custom",
          content: "Visible extension review",
          details: { source: "extension" },
        },
      ];
      const range = {
        afterMessageId: "a1:0",
        messageCount: 3,
        kinds: ["tool", "thinking"],
      };
      expect(older.messages).toMatchObject(visible);
      expect(older.activityRanges).toMatchObject([range]);

      const turnId = reopened.userTurnIndexPage(0).turns[0]!.id;
      const turn = reopened.userTurnTranscriptPage(turnId);
      expect(turn.messages.slice(0, visible.length)).toMatchObject(visible);
      expect(turn.activityRanges).toMatchObject([range]);
      expect(JSON.stringify(turn.messages)).not.toContain("private context");

      const cursor = older.activityRanges![0]!.cursor;
      expect(reopened.activityPage(cursor).messages).toMatchObject(
        ["tool", "result", "thought"].map((id) => ({ __inspireEntryId: id })),
      );
      expect(() => reopened.visiblePage(cursor)).toThrow(/wrong purpose/);
    } finally {
      await reopened.close();
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
      projection.visiblePage(page.olderCursor!, projection.leafId, "view-a")
        .messages.length,
    ).toBeGreaterThan(0);
    expect(
      page.messages.some((value) => JSON.stringify(value).includes("hidden 0")),
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
    expect(() => projection.visiblePage(page.continuationCursor!)).toThrow(
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
    const ids: unknown[] = [];
    const entryIds: unknown[] = [];
    let page = projection.latestPage();
    while (true) {
      const messages = [...page.messages];
      for (const range of page.activityRanges ?? []) {
        let cursor: string | null = range.cursor;
        while (cursor) {
          const activity = projection.activityPage(cursor);
          messages.push(...activity.messages);
          cursor = activity.cursor;
        }
      }
      ids.push(
        ...messages.map(
          (value) => (value as Record<string, unknown>).__inspireMessageId,
        ),
      );
      entryIds.push(
        ...messages.map(
          (value) => (value as Record<string, unknown>).__inspireEntryId,
        ),
      );
      if (!page.hasOlder) break;
      page = projection.visiblePage(page.olderCursor!);
    }
    expect(ids).toHaveLength(120);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(120);
    expect(new Set(entryIds)).toEqual(new Set(lines.map(({ id }) => id)));
  });

  it("keeps paging cursors through an ordinary append and retires them when their authority changes", async () => {
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
    const { directory, path, projection, record } = await fixture(many);
    const latest = projection.latestPage();
    expect(latest.hasOlder).toBe(true);
    expect(latest.messages.length).toBeLessThanOrEqual(
      TRANSCRIPT_PAGE_MAX_MESSAGES,
    );
    const cursor = latest.olderCursor!;
    const viewBound = projection.latestPage([], projection.leafId, "view-a")
      .olderCursor!;
    expect(() =>
      projection.visiblePage(viewBound, projection.leafId, "view-b"),
    ).toThrow(/another branch view/);
    let oldest = latest;
    while (oldest.hasOlder)
      oldest = projection.visiblePage(oldest.olderCursor!);
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
    expect(projection.messages.at(-1)).toMatchObject({ content: "watched" });
    expect(projection.visiblePage(cursor).revision).toBeGreaterThan(
      latest.revision,
    );
    expect(projection.composerHistoryPage().composerHistoryVersion).toBe(
      latest.composerHistoryVersion,
    );

    const reopened = await SessionProjection.open(record);
    try {
      expect(() => reopened.visiblePage(cursor)).toThrow(
        /expired projection incarnation/,
      );
    } finally {
      await reopened.close();
    }

    await appendFile(
      path,
      jsonl({
        type: "compaction",
        id: "compact",
        parentId: "last",
        timestamp: "2026-08-01T00:03:00.000Z",
        summary: "compacted history",
        firstKeptEntryId: "m2",
        tokensBefore: 1_000,
      }),
    );
    await projection.reconcile(true);
    expect(() => projection.visiblePage(cursor)).toThrow(/stale/);
    const compacted = projection.latestPage();
    expect(compacted.composerHistoryVersion).toBe(
      latest.composerHistoryVersion,
    );
    expect(compacted.olderCursor).toBeTruthy();
    expect(
      projection.visiblePage(compacted.olderCursor!).messages.length,
    ).toBeGreaterThan(0);

    const replacement = join(directory, "replacement.jsonl");
    await writeFile(
      replacement,
      jsonl(header(), message("replacement", null, "user", "rewrite", 300)),
    );
    await rename(replacement, path);
    await projection.reconcile(true);
    expect(() => projection.visiblePage(compacted.olderCursor!)).toThrow(
      /stale/,
    );
  });
});

describe("chronological compaction projection", () => {
  it("keeps live, reopened, repeated and earlier-branch views in persisted order", async () => {
    const { path, record, projection } = await fixture([
      message("u1", null, "user", "old", 1),
      message("a1", "u1", "assistant", "old answer", 2),
      message("u2", "a1", "user", "retained", 3),
      message("a2", "u2", "assistant", "retained answer", 4),
    ]);
    const ids = (messages: readonly unknown[]) =>
      messages.map(
        (value) => (value as { __inspireEntryId: string }).__inspireEntryId,
      );
    const compact = (
      id: string,
      parentId: string,
      firstKeptEntryId: string,
    ) => ({
      type: "compaction",
      id,
      parentId,
      firstKeptEntryId,
      // Deliberately earlier than the retained messages: never sort timestamps.
      timestamp: new Date(0).toISOString(),
      summary: id,
      tokensBefore: 1000,
      details: { source: "magic-context", lastCompactedOrdinal: 2 },
      systemMessage: {
        role: "system",
        content: "host-only compaction checkpoint",
        toolsAdded: [],
        timestamp: 0,
      },
    });
    await appendFile(path, JSON.stringify(compact("c1", "a2", "u2")) + "\n");
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u2", "a2", "c1"]);
    await appendFile(
      path,
      [
        message("u3", "c1", "user", "after compaction", 5),
        message("a3", "u3", "assistant", "new answer", 6),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u2", "a2", "c1", "u3", "a3"]);
    const reopened = await SessionProjection.open(record);
    try {
      expect(ids(reopened.messages)).toEqual(ids(projection.messages));
      expect(reopened.messages[2]).toMatchObject({
        role: "compactionSummary",
        __inspireCompactionSource: "magic-context",
        tokensBefore: 1000,
      });
      expect(reopened.messages[2]).not.toHaveProperty("details");
    } finally {
      await reopened.close();
    }
    await appendFile(path, JSON.stringify(compact("c2", "a3", "u3")) + "\n");
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u3", "a3", "c2"]);
    expect(ids(projection.viewMessages("a3"))).toEqual([
      "u2",
      "a2",
      "c1",
      "u3",
      "a3",
    ]);
    const before = await readFile(path, "utf8");
    const branch = jsonl(
      message(
        "tool",
        "a1",
        "assistant",
        [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        7,
      ),
      {
        ...message("result", "tool", "toolResult", "tool output", 8),
        message: {
          role: "toolResult",
          content: "tool output",
          toolCallId: "call",
          timestamp: 8,
        },
      },
    );
    await appendFile(path, branch);
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u1", "a1", "tool", "result"]);
    expect(projection.messages.at(-1)).toMatchObject({
      content: "tool output",
    });
    expect(await readFile(path, "utf8")).toBe(before + branch);
  });
});
