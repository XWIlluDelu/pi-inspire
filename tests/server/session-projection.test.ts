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
import { piInstallation } from "../../server/pi-installation.js";
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
import { savedAssistant } from "../fixtures/history-session.js";
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

async function sessionFile() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-projection-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const record: SessionRecord = {
    id: "session-a",
    path,
    source: null,
    cwd: "/project",
    created: new Date(),
    modified: new Date(),
    messageCount: 0,
    firstMessage: "",
  };
  return { directory, path, record };
}

async function fixture(
  lines: unknown[],
  options: {
    readHooks?: SessionProjectionReadHooks;
    fileNameForPath?: (path: string) => string | null;
  } = {},
) {
  const file = await sessionFile();
  const bytes = jsonl(header(), ...lines);
  await writeFile(file.path, bytes);
  return {
    ...file,
    bytes,
    projection: await openProjection(
      file.record,
      options.readHooks,
      options.fileNameForPath,
    ),
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
    const { directory: cwd, path, record } = await sessionFile();
    const timestamp = new Date(0);
    const original = jsonl(
      { type: "session", id: record.id, cwd, timestamp },
      {
        type: "message",
        timestamp,
        message: { role: "user", content: "legacy", timestamp: 0 },
      },
    );
    await writeFile(path, original);
    const projection = await openProjection({ ...record, cwd });
    expect(projection.latestPage().messages).toMatchObject([
      { role: "user", content: "legacy" },
    ]);
    expect(await readFile(path, "utf8")).toBe(original);
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
      { fileNameForPath: (file) => (file === reference ? name : null) },
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

  it("attests a pending native file through its first complete append and checks its project identity", async () => {
    const { directory, path, record } = await sessionFile();
    const alias = join(directory, "alias");
    const other = join(directory, "other");
    await mkdir(other);
    await symlink(directory, alias, "junction");
    record.cwd = alias;
    await expect(SessionProjection.open(record)).rejects.toThrow(
      /ENOENT|no such file/i,
    );
    const projection = await SessionProjection.openPending(record);
    projections.push(projection);
    await projection.suspendReconciliation();
    await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
      changed: false,
      sourceChanged: false,
      health: { status: "ok" },
    });
    expect(projection.sourceIdentity).toBeNull();

    const firstHeader = JSON.stringify({ ...header(), cwd: directory });
    await writeFile(path, firstHeader.slice(0, -1));
    await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
      changed: false,
      sourceChanged: true,
      committedBytes: 0,
      uncommittedBytes: Buffer.byteLength(firstHeader) - 1,
      health: { status: "pending" },
    });
    expect(projection.attestInitialMaterialization([])).toBe("partial");

    const entries = (
      [
        {
          type: "model_change",
          id: "model",
          parentId: null,
          provider: "test",
          modelId: "model",
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "model",
          thinkingLevel: "medium",
        },
      ] as const
    ).map((entry) => ({ ...entry, timestamp: new Date(1).toISOString() }));
    await appendFile(path, firstHeader.slice(-1) + "\n" + jsonl(...entries));
    await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
      changed: true,
      kind: "append",
      previousTailVerified: true,
      uncommittedBytes: 0,
      health: { status: "ok" },
    });
    expect(projection.attestInitialMaterialization(entries)).toBe("complete");
    await expect(
      SessionProjection.openPending({ ...record, cwd: other }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("redacts nested credentials and retains identity and outcome under transcript budgets", () => {
    const dense = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `field-${index}`,
        "x".repeat(4_000),
      ]),
    );
    expect(
      boundedTranscriptValue({
        authorization: "secret",
        nested: { token: "secret", text: "x".repeat(70_000) },
      }),
    ).toMatchObject({
      authorization: "[redacted]",
      nested: { token: "[redacted]", text: expect.stringMatching(/truncated/) },
    });
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

  it("admits a split UTF-8 frame only on completion, and detects later unresolved tail loss", async () => {
    const { path, projection } = await fixture([
      message("u1", null, "user", "good", 1),
    ]);
    await projection.suspendReconciliation();
    const reconcile = () => projection.reconcileSuspended(true);
    const { revision, sourceVersion } = projection;
    const text = "完整";
    const bytes = Buffer.from(jsonl(message("a1", "u1", "assistant", text, 2)));
    const split = bytes.indexOf(Buffer.from(text)) + 1;
    await appendFile(path, bytes.subarray(0, split));
    await expect(reconcile()).resolves.toMatchObject({
      changed: false,
      sourceChanged: true,
      previousUncommittedBytes: 0,
      uncommittedBytes: split,
    });
    expect(projection.revision).toBe(revision);
    expect(projection.sourceVersion).not.toBe(sourceVersion);
    expect(projection.messages).toHaveLength(1);
    await appendFile(path, bytes.subarray(split));
    await expect(reconcile()).resolves.toMatchObject({
      changed: true,
      kind: "append",
      uncommittedBytes: 0,
      previousTailVerified: true,
    });
    expect(projection.messages.at(-1)).toMatchObject({ content: text });
    const committed = await readFile(path);

    for (const tail of ["", "partial-b"]) {
      await appendFile(path, "partial-a");
      await expect(reconcile()).resolves.toMatchObject({ uncommittedBytes: 9 });
      if (tail)
        await writeFile(path, Buffer.concat([committed, Buffer.from(tail)]));
      else await truncate(path, committed.length);
      await expect(reconcile()).resolves.toMatchObject({
        changed: false,
        sourceChanged: true,
        uncommittedBytes: tail.length,
        previousTailVerified: false,
      });
      await truncate(path, committed.length);
      await reconcile();
    }
  });

  // This intentionally streams a 32 MiB + 1 byte adversarial entry. It has
  // no external dependency, but may legitimately exceed Vitest's 5s default
  // when the full server suite is CPU- and I/O-contended in CI.
  it("keeps the last good projection through I/O failure, invalid JSONL, and invalid graph identities", async () => {
    const good = message("u1", null, "user", "good", 1);
    const { path, projection } = await fixture([good]);
    await projection.suspendReconciliation();
    const { revision, messages } = projection;
    const unchanged = async (error: RegExp) => {
      await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
        changed: false,
        health: { status: "error", message: expect.stringMatching(error) },
      });
      expect(projection.revision).toBe(revision);
      expect(projection.messages).toEqual(messages);
    };
    vi.mocked(open).mockRejectedValueOnce(new Error("temporary read failure"));
    await unchanged(/temporary read failure/);
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      changed: false,
      healthChanged: true,
      health: { status: "ok" },
    });

    await appendFile(path, "{malformed}\n");
    await unchanged(/malformed/);
    for (const [bytes, error] of [
      [
        jsonl(header()) + "x".repeat(MAX_PERSISTED_ENTRY_BYTES + 1) + "\n",
        /exceeds/,
      ],
      [jsonl(header("another-session")), /another session/],
      [
        jsonl(header(), good, message("u1", "u1", "assistant", "duplicate", 2)),
        /duplicate entry/i,
      ],
      [
        jsonl(header(), message("u1", "missing", "user", "orphan", 1)),
        /missing or forward parent/i,
      ],
      [
        jsonl(
          header(),
          message("u1", "u2", "user", "cycle", 1),
          message("u2", "u1", "assistant", "cycle", 2),
        ),
        /missing or forward parent/i,
      ],
    ] as const) {
      await writeFile(path, bytes);
      await unchanged(error);
    }
    await writeFile(
      path,
      jsonl(header(), message("u1", null, "user", "repaired", 1)),
    );
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      health: { status: "ok" },
    });
    expect(projection.messages).toMatchObject([
      { role: "user", content: "repaired" },
    ]);
  }, 15_000);
});

describe("SessionProjection replacement and Pi context semantics", () => {
  it("builds incremental context from a verified suffix exactly as a fresh Pi read would", async () => {
    const { path, record, projection } = await fixture([
      message("s1", null, "system", "host-only startup", 0),
      message("u1", "s1", "user", "one", 1),
    ]);
    const prefix = projection.messages[0];
    expect(projection.viewMessages("s1")).toEqual([]);
    const entries = [
      { type: "session_info", id: "info", parentId: "u1", name: "Named" },
      {
        type: "model_change",
        id: "model",
        parentId: "info",
        provider: "test-provider",
        modelId: "test-model",
      },
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "model",
        thinkingLevel: "high",
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "thinking",
        customType: "notice",
        content: "custom context",
        display: true,
      },
      {
        type: "branch_summary",
        id: "summary",
        parentId: "custom",
        fromId: "u1",
        summary: "branch context",
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: new Date(index + 2).toISOString(),
    }));
    await appendFile(
      path,
      jsonl(
        ...entries,
        message("a1", "summary", "assistant", "two", 7, {
          provider: "answer-provider",
          model: "answer-model",
        }),
        message("s2", "a1", "system", "host-only update", 8),
      ),
    );
    await expect(projection.reconcile(true)).resolves.toMatchObject({
      kind: "append",
      replacesRows: false,
    });
    expect(projection.messages[0]).toBe(prefix);
    expect(projection.leafId).toBe("s2");
    expect(projection.viewMessages("s2")).toEqual(projection.messages);
    expect(JSON.stringify(projection.latestPage())).not.toContain("host-only");
    const fresh = await openProjection(record);
    expect(projection).toMatchObject({
      messages: fresh.messages,
      model: fresh.model,
      thinkingLevel: fresh.thinkingLevel,
    });
  });

  it("keeps raw History independent from native assistant context edits and then applies retain-none compaction", async () => {
    const { directory, path, record, projection } = await fixture([
      message("u1", null, "user", "original user text", 1),
      messageEntry(
        "a1",
        "u1",
        savedAssistant("original assistant text", { timestamp: 2 }),
      ),
    ]);
    const { SessionManager, buildSessionContext } = piInstallation.sdk;
    const manager = SessionManager.open(path, directory, directory);
    const original = projection.latestPage().messages;
    for (const content of ["replacement context", null]) {
      const id = manager.appendContextEdit(
        "a1",
        content === null ? null : { content },
      );
      await expect(projection.reconcile(true)).resolves.toMatchObject({
        changed: true,
        kind: "append",
      });
      expect(projection.entry(id)?.type).toBe("context_edit");
      expect(projection.latestPage().messages).toEqual(original);
      const assistants = buildSessionContext(
        manager.getEntries(),
      ).messages.filter((message) => message.role === "assistant");
      expect(assistants.map(({ content }) => content)).toEqual(
        content === null ? [] : [[{ type: "text", text: content }]],
      );
    }
    const bytes = await readFile(path);
    expect((await openProjection(record)).latestPage().messages).toEqual(
      original,
    );
    expect(await readFile(path)).toEqual(bytes);

    const compacted = manager.appendCompaction("retained summary", null, 15);
    expect(manager.getEntry(compacted)).toMatchObject({
      type: "compaction",
      firstKeptEntryId: compacted,
    });
    manager.appendMessage({
      role: "user",
      content: "after compaction",
      timestamp: 3,
    });
    await projection.reconcile(true);
    expect(projection.health.status).toBe("ok");
    expect(projection.latestPage().messages).toMatchObject([
      { role: "compactionSummary", summary: "retained summary" },
      { role: "user", content: "after compaction" },
    ]);
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

  it("publishes a coherent same-size rewrite, then drains an active read and rejects its successor on close", async () => {
    let pause: (() => Promise<void>) | undefined;
    const size = 256 * 1024;
    const entry = (character: string) =>
      message("u1", null, "user", character.repeat(size), 1);
    const { path, projection } = await fixture([entry("A")], {
      readHooks: {
        async afterFullReadChunk() {
          const wait = pause;
          pause = undefined;
          await wait?.();
        },
      },
    });
    await projection.suspendReconciliation();
    const holdRead = () => {
      const entered = deferredSignal();
      const release = deferredSignal();
      pause = () => {
        entered.resolve();
        return release.promise;
      };
      return { entered: entered.promise, release: release.resolve };
    };
    const rewrite = async (character: string) =>
      writeFile(path, jsonl(header(), entry(character)));

    const before = await stat(path);
    await rewrite("B");
    await utimes(path, before.atime, before.mtime);
    const racing = holdRead();
    const reconciling = projection.reconcileSuspended();
    try {
      await racing.entered;
      await rewrite("C");
    } finally {
      racing.release();
    }
    await expect(reconciling).resolves.toMatchObject({
      kind: "rewrite",
      replacesRows: true,
      health: { status: "ok" },
    });
    expect(projection.messages[0]).toMatchObject({ content: "C".repeat(size) });
    await truncate(path, Buffer.byteLength(jsonl(header())));
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      kind: "rewrite",
      changed: true,
    });
    expect(projection.messages).toEqual([]);

    // Rewriting the committed header forces a full read for the close fence.
    await writeFile(
      path,
      jsonl({ ...header(), timestamp: new Date(1).toISOString() }, entry("D")),
    );
    const held = holdRead();
    const reading = projection.reconcileSuspended(true);
    try {
      await held.entered;
      const queued = expect(
        projection.reconcileSuspended(true),
      ).rejects.toThrow(/closed/);
      let closed = false;
      const closing = projection.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      held.release();
      await Promise.all([reading, closing, queued]);
    } finally {
      held.release();
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
    const { projection } = await fixture([
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

  it("keeps native History pinned across two compactions and branch appends, then rejects a replaced file", async () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      message(
        `u${index}`,
        index ? `u${index - 1}` : null,
        "user",
        `Prompt ${index}`,
        index + 1,
      ),
    );
    const { directory, path, record, projection } = await fixture(entries);
    const append = async (...lines: unknown[]) => {
      await appendFile(path, jsonl(...lines));
      await projection.reconcile(true);
    };
    const ids = (rows: readonly unknown[]) =>
      rows.map((row) => (row as { __inspireEntryId: string }).__inspireEntryId);
    const cursorPage = (
      cursor?: string,
      leaf = projection.leafId,
      view = "view-a",
    ) => projection.historyPage({ kind: "page", cursor }, leaf, view);
    const latest = cursorPage();
    expect(latest.earlier).not.toBeNull();
    const cursor = latest.earlier!;
    const older = cursorPage(cursor);
    expect(() => cursorPage(cursor, projection.leafId, "view-b")).toThrow(
      /another branch view/,
    );
    expect(() => cursorPage(cursor, "u18")).toThrow(/selected branch/);
    const tampered = (cursor.startsWith("A") ? "B" : "A") + cursor.slice(1);
    expect(() => cursorPage(tampered)).toThrow(/cursor/i);
    const version = projection.latestPage().composerHistoryVersion;

    const compact = (
      id: string,
      parentId: string,
      firstKeptEntryId: string,
    ) => ({
      type: "compaction",
      id,
      parentId,
      firstKeptEntryId,
      timestamp: new Date(0).toISOString(),
      summary: id,
      tokensBefore: 1000,
      details: { source: "magic-context", lastCompactedOrdinal: 2 },
      systemMessage: {
        role: "system",
        content: "host-only checkpoint",
        toolsAdded: [],
        timestamp: 0,
      },
    });
    await append(compact("c1", "u19", "u18"));
    expect(ids(projection.messages)).toEqual(["u18", "u19", "c1"]);
    expect(projection.latestPage().composerHistoryVersion).toBe(version);
    expect(cursorPage(cursor)).toMatchObject({
      leafId: latest.leafId,
      messages: older.messages,
    });

    await append(message("follow", "c1", "user", "After compaction", 21));
    const following = projection.latestPage().composerHistoryVersion;
    expect(following).not.toBe(version);
    expect(
      projection.historyPage({ kind: "composer" }).composerHistoryVersion,
    ).toBe(following);
    expect(projection.latestPage([], "c1").composerHistoryVersion).toBe(
      version,
    );
    const reopened = await openProjection(record);
    expect(reopened.messages).toEqual(projection.messages);
    expect(reopened.messages[2]).toMatchObject({
      role: "compactionSummary",
      __inspireCompactionSource: "magic-context",
      tokensBefore: 1000,
    });
    expect(reopened.messages[2]).not.toHaveProperty("details");
    expect(() =>
      reopened.historyPage({ kind: "page", cursor }, reopened.leafId, "view-a"),
    ).toThrow(/expired projection incarnation/);

    await append(compact("c2", "follow", "follow"));
    expect(ids(projection.messages)).toEqual(["follow", "c2"]);
    expect(ids(projection.viewMessages("follow"))).toEqual([
      "u18",
      "u19",
      "c1",
      "follow",
    ]);
    const beforeBranch = await readFile(path, "utf8");
    const branches = [
      message("left", "u18", "assistant", "Side reply", 26),
      message("right", "u18", "assistant", "Other reply", 27),
      message("left-first", "left", "user", "First left", 30),
      message("right-end", "right", "user", "Right end", 31),
      message("left-end", "left", "user", "Left end", 28),
    ];
    await append(...branches);
    expect(ids(projection.messages)).toEqual([
      ...entries.slice(0, 19).map(({ id }) => id),
      "left",
      "left-end",
    ]);
    for (const [from, tip] of [
      ["left", "left-end"],
      ["right", "right-end"],
      ["right-end", "right-end"],
      ["u18", "left-end"],
      [null, "left-end"],
      ["missing", "missing"],
    ] as const) {
      expect(projection.latestContinuation(from)).toBe(tip);
    }
    expect(() => cursorPage(cursor)).toThrow(/selected branch/);
    expect(cursorPage(cursor, "c2").messages).toEqual(older.messages);
    const branched = projection.latestPage().composerHistoryVersion;
    expect(branched).not.toBe(following);
    expect(projection.historyPage({ kind: "composer" }).entries[0]?.text).toBe(
      "Left end",
    );
    const beforeReplace = await readFile(path, "utf8");
    expect(beforeReplace).toBe(beforeBranch + jsonl(...branches));

    const replacement = join(directory, "replacement.jsonl");
    await writeFile(replacement, beforeReplace);
    await rename(replacement, path);
    await expect(projection.reconcile(true)).resolves.toMatchObject({
      kind: "rewrite",
      changed: false,
      sourceChanged: true,
    });
    expect(() => cursorPage(cursor, "c2")).toThrow(/stale/);

    await writeFile(path, beforeReplace.replace("Prompt 0", "Rewritten"));
    await projection.reconcile(true);
    expect(projection.latestPage().composerHistoryVersion).not.toBe(branched);
    expect(
      projection.historyPage({ kind: "composer" }).entries.at(-1)?.text,
    ).toBe("Rewritten");
  });
});
