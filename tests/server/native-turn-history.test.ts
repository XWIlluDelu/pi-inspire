import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TRANSCRIPT_PAGE_MAX_BYTES } from "../../server/session-projection.js";
import {
  disposeProjectionFixture,
  initializeProjectionFixture,
  setup,
  runtimeProjection,
} from "./fixtures/runtime-projection.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

beforeEach(initializeProjectionFixture);
afterEach(disposeProjectionFixture);

const entry = (id: string, parentId: string, role: string, content: string) =>
  messageEntry(id, parentId, { role, content, timestamp: 2 });

it("pages a large saved branch in both directions, including pre-compaction turns and a giant entry", async () => {
  const giant = "before ".repeat(22_000) + "NEEDLE_BEYOND_PREVIEW";
  const entries = [entry("giant", "u1", "assistant", giant)];
  let parent = "giant";
  for (let i = 2; i <= 20; i++) {
    entries.push(entry(`u${i}`, parent, "user", `Prompt ${i}`));
    entries.push(entry(`a${i}`, `u${i}`, "assistant", `Reply ${i}`));
    parent = `a${i}`;
  }
  const { runtime } = await setup([
    ...entries,
    {
      type: "compaction",
      id: "compact",
      parentId: parent,
      firstKeptEntryId: "u18",
      summary: "A summary",
      tokensBefore: 300,
      timestamp: "2026-08-01T00:00:03.000Z",
    },
  ]);
  const snapshot = await runtime.snapshot("session-a");
  const viewId = snapshot.active!.transcriptPage.viewId;
  const read = (cursor?: string) =>
    runtime.sessionHistory("session-a", viewId, { kind: "page", cursor });
  const newest = await read();
  const ids = (page: typeof newest) =>
    page.messages.map(
      (row) => (row as { __inspireEntryId: string }).__inspireEntryId,
    );
  const seen: string[] = [];
  let page = newest;
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      TRANSCRIPT_PAGE_MAX_BYTES,
    );
    seen.unshift(...ids(page));
    if (!page.earlier) break;
    page = await read(page.earlier);
  }
  expect(seen).toEqual(["u1", ...entries.map((value) => value.id), "compact"]);
  expect(ids(await read(page.later!))[0]).toBe(seen[page.messages.length]);
  const before = await runtime.sessionHistory("session-a", viewId, {
    kind: "page",
    direction: "earlier",
    entryId: "u18",
  });
  expect(ids(before).at(-1)).toBe("a17");
  expect(ids(await read(before.later!))[0]).toBe("u18");
  const prompts = await runtime.sessionHistory("session-a", viewId, {
    kind: "turns",
  });
  expect(prompts).toMatchObject({
    total: 20,
    start: 0,
    turns: [
      expect.objectContaining({ id: "u1", ordinal: 0 }),
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `u${index + 2}`,
        ordinal: index + 1,
        snippet: `Prompt ${index + 2}`,
        attachmentCount: 0,
      })),
    ],
  });
  const found = await runtime.sessionHistory("session-a", viewId, {
    kind: "page",
    entryId: "giant",
  });
  expect(ids(found)[0]).toBe("giant");
  let offset = 0;
  let copied = "";
  for (;;) {
    const part = await runtime.sessionHistory("session-a", viewId, {
      kind: "entry",
      targetId: "giant",
      offset,
    });
    copied += part.text;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  }
  expect(copied).toBe(giant);
});

it("keeps valid external appends on disk, fences incomplete writes, and retires on replacement", async () => {
  const { runtime, workers, path } = await setup();
  const worker = workers[0]!;
  const { slot, reconcile } = runtimeProjection(runtime);
  await runtime.snapshot("session-a");
  const foreign = entry("foreign", "u1", "assistant", "External reply");
  const frame = jsonl(foreign);
  await appendFile(path, frame.slice(0, -1));
  await reconcile();
  await expect(
    runtime.prompt({ sessionId: "session-a", message: "wait" }),
  ).rejects.toThrow(/incomplete/i);
  expect(worker.stops).toBe(0);
  await appendFile(path, "\n");
  await reconcile();
  const state = await runtime.snapshot("session-a");
  expect(state.active).toMatchObject({
    effectiveLeafId: "u1",
    durableLeafId: "foreign",
  });
  const saved = await runtime.sessionHistory(
    "session-a",
    state.active!.transcriptPage.viewId,
    { kind: "page", leafId: "foreign" },
  );
  expect(saved.messages.at(-1)).toMatchObject({ __inspireEntryId: "foreign" });
  expect(slot.conflict).toBeNull();
  const original = await readFile(path);
  await writeFile(`${path}.replacement`, original);
  await rename(`${path}.replacement`, path);
  await reconcile();
  expect(worker.stops).toBe(1);
});

it("retains unsaved live output and reads only the saved prefix while Pi's leaf leads the file", async () => {
  const { runtime, workers, path } = await setup();
  const worker = workers[0]!;
  worker.emit("event", { type: "agent_start" });
  worker.emit("event", {
    type: "message_end",
    message: { role: "assistant", timestamp: 2, content: "unsaved output" },
  });
  worker.publishCheckpoint([], { sealed: "settled" });
  worker.emit("event", { type: "agent_settled" });
  const page = (await runtime.snapshot("session-a")).active!.transcriptPage;
  expect(page.messages.at(-1)).toMatchObject({
    content: "unsaved output",
    __inspireUnconfirmed: true,
  });
  expect(page.messages.at(-1)).not.toHaveProperty("__inspireEntryId");

  const native = entry("native", "u1", "assistant", "unsaved output");
  worker.publishCheckpoint([native], { sealed: "settled" });
  expect((await runtime.snapshot("session-a")).active).toMatchObject({
    effectiveLeafId: "native",
    transcriptPage: {
      messages: expect.arrayContaining([
        expect.objectContaining({ __inspireEntryId: "native" }),
      ]),
    },
  });
  const saved = () =>
    runtime.sessionHistory("session-a", page.viewId, { kind: "page" });
  expect((await saved()).leafId).toBe("u1");
  await appendFile(path, jsonl(native));
  expect((await saved()).leafId).toBe("native");
});
