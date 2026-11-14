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
    const original = jsonl(
      { type: "session", id, cwd, timestamp },
      {
        type: "message",
        timestamp,
        message: { role: "user", content: "legacy", timestamp: 0 },
      },
    );
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
      projection.historyPage(
        { kind: "entry", targetId: "mixed-input", offset: 0 },
        "mixed-input",
      ),
    ).toMatchObject({
      text,
      totalChars: text.length,
      nextOffset: null,
      images: [
        { index: 1, mimeType: "image/png" },
        { index: 2, mimeType: "image/webp" },
      ],
    });
    expect(
      projection.historyPage({ kind: "routes", parentId: "" }).nodes[0]?.label,
    ).toBe(`${caption} report.csv [Image: image/png] [Image: image/webp]`);
    expect(
      projection.historyPage({ kind: "search", text: reference }).matches[0]
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
    expect(
      projection.historyPage({ kind: "composer" }).composerHistoryVersion,
    ).toBe(appended);
    expect(projection.latestPage([], "u1").composerHistoryVersion).toBe(
      original,
    );

    const branch = message("u3", "u1", "user", "alternate", 3);
    await appendFile(path, `${JSON.stringify(branch)}\n`);
    await projection.reconcile(true);
    const branched = projection.latestPage().composerHistoryVersion;
    expect(branched).not.toBe(appended);
    expect(
      projection
        .historyPage({ kind: "composer" })
        .entries.map((entry) => entry.text),
    ).toEqual(["alternate", "first"]);

    await writeFile(
      path,
      jsonl(
        header(),
        { ...first, message: { ...first.message, content: "rewritten" } },
        second,
        branch,
      ),
    );
    await projection.reconcile(true);
    expect(projection.latestPage().composerHistoryVersion).not.toBe(branched);
    expect(projection.latestPage([], "u1").composerHistoryVersion).not.toBe(
      original,
    );
    expect(
      projection
        .historyPage({ kind: "composer" })
        .entries.map((entry) => entry.text),
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
  it("keeps the verified linear suffix projection equivalent to a fresh Pi context build", async () => {
    const { path, record, projection } = await fixture([
      message("s1", null, "system", "host-only startup", 0),
      message("u1", "s1", "user", "one", 1),
    ]);
    const prefix = projection.messages[0];
    let fresh: SessionProjection | null = null;
    try {
      expect(projection.viewMessages("s1")).toEqual([]);
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
        sourceChanged: false,
        health: { status: "ok" },
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
      const before = await stat(path);
      await writeFile(path, jsonl(header(), entry("B".repeat(size))));
      await utimes(path, before.atime, before.mtime);
      pause = true;
      const reconciling = projection.reconcileSuspended();
      await entered.promise;
      const content = "C".repeat(size);
      await writeFile(path, jsonl(header(), entry(content)));
      release.resolve();
      await expect(reconciling).resolves.toMatchObject({
        kind: "rewrite",
        health: { status: "ok" },
      });
      expect(projection.messages[0]).toMatchObject({ content });
      await truncate(path, Buffer.byteLength(jsonl(header())));
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        kind: "rewrite",
        changed: true,
      });
      expect(projection.messages).toEqual([]);
    } finally {
      release.resolve();
      projection.resumeReconciliation();
      await projection.close();
    }
  });
});

describe("SessionProjection bounded paging", () => {
  it("pages a native turn over 10 MiB across equal-timestamp results and saved outcomes", async () => {
    const body = "z".repeat(480_000);
    const lines = Array.from({ length: 120 }, (_, index) =>
      message(
        `result-${index}`,
        index ? `result-${index - 1}` : "private",
        "toolResult",
        index < 24 ? body : `Result ${index}`,
        2,
        {
          toolCallId: `call-${index}`,
          toolName: "read",
        },
      ),
    );
    const { record, projection: initial } = await fixture([
      message("user", null, "user", "Read", 1),
      message(
        "call",
        "user",
        "assistant",
        [{ type: "toolCall", id: "call-0", name: "read", arguments: {} }],
        2,
      ),
      message("error", "call", "assistant", [], 2, {
        stopReason: "error",
        errorMessage: "fetch failed",
      }),
      message(
        "aborted",
        "error",
        "assistant",
        [{ type: "thinking", thinking: "partial" }],
        2,
        { stopReason: "aborted", errorMessage: "interrupted" },
      ),
      {
        type: "custom_message",
        id: "review",
        parentId: "aborted",
        timestamp: new Date(2).toISOString(),
        customType: "review",
        content: "Visible extension review",
        details: { source: "extension" },
        display: true,
      },
      message("private", "review", "custom", "private context", 2, {
        display: false,
      }),
      ...lines,
    ]);
    await initial.close();
    const projection = await openProjection(record);
    let page = projection.historyPage({ kind: "page" });
    const firstRevision = page.revision;
    const received: string[] = [];
    expect(page.earlier).not.toBeNull();
    for (;;) {
      expect(page.revision).toBe(firstRevision);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        TRANSCRIPT_PAGE_MAX_BYTES,
      );
      received.unshift(
        ...page.messages.map(
          (row) => (row as { __inspireEntryId: string }).__inspireEntryId,
        ),
      );
      if (!page.earlier) break;
      page = projection.historyPage({ kind: "page", cursor: page.earlier });
    }
    expect(received).toEqual([
      "user",
      "call",
      "error",
      "aborted",
      "review",
      "private",
      ...lines.map(({ id }) => id),
    ]);
    const earliest = projection.historyPage({
      kind: "page",
      entryId: "user",
    }).messages;
    expect(earliest.slice(0, 6)).toMatchObject([
      { role: "user" },
      { content: [{ id: "call-0" }] },
      { stopReason: "error", errorMessage: "fetch failed" },
      { stopReason: "aborted", errorMessage: "interrupted" },
      { role: "custom", content: "Visible extension review" },
      { role: "custom", display: false },
    ]);
    expect(earliest[6]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-0",
    });
  }, 30_000);

  it("keeps a native cursor pinned through appends and compaction, then rejects replaced sources", async () => {
    const lines = Array.from({ length: 22 }, (_, index) =>
      message(
        `u${index}`,
        index ? `u${index - 1}` : null,
        "user",
        `Prompt ${index}`,
        index + 1,
      ),
    );
    const { directory, path, projection } = await fixture(lines);
    const latest = projection.historyPage(
      { kind: "page" },
      projection.leafId,
      "view-a",
    );
    const query = { kind: "page", cursor: latest.earlier! } as const;
    const older = projection.historyPage(query, projection.leafId, "view-a");
    expect(() =>
      projection.historyPage(query, projection.leafId, "view-b"),
    ).toThrow(/another branch view/);
    await appendFile(
      path,
      jsonl({
        type: "compaction",
        id: "compact",
        parentId: "u21",
        firstKeptEntryId: "u18",
        summary: "Summary",
        tokensBefore: 1000,
        timestamp: "2026-08-01T00:03:00.000Z",
      }),
    );
    await projection.reconcile(true);
    const after = projection.historyPage(query, projection.leafId, "view-a");
    expect(after.messages).toEqual(older.messages);
    expect(after.leafId).toBe(latest.leafId);
    const replacement = join(directory, "replacement.jsonl");
    await writeFile(replacement, await readFile(path));
    await rename(replacement, path);
    await expect(projection.reconcile(true)).resolves.toMatchObject({
      kind: "rewrite",
      changed: false,
      sourceChanged: true,
    });
    expect(() =>
      projection.historyPage(query, projection.leafId, "view-a"),
    ).toThrow(/stale/);
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
    await appendFile(path, jsonl(compact("c1", "a2", "u2")));
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u2", "a2", "c1"]);
    await appendFile(
      path,
      jsonl(
        message("u3", "c1", "user", "after compaction", 5),
        message("a3", "u3", "assistant", "new answer", 6),
      ),
    );
    await projection.reconcile(true);
    expect(ids(projection.messages)).toEqual(["u2", "a2", "c1", "u3", "a3"]);
    const reopened = await openProjection(record);
    expect(ids(reopened.messages)).toEqual(ids(projection.messages));
    expect(reopened.messages[2]).toMatchObject({
      role: "compactionSummary",
      __inspireCompactionSource: "magic-context",
      tokensBefore: 1000,
    });
    expect(reopened.messages[2]).not.toHaveProperty("details");
    await appendFile(path, jsonl(compact("c2", "a3", "u3")));
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
      message("result", "tool", "toolResult", "tool output", 8, {
        toolCallId: "call",
      }),
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
