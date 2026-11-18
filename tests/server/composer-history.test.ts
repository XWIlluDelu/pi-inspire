import { appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";
import {
  composerHistoryEntries,
  projectComposerHistoryPage,
} from "../../server/composer-history.js";
import { ResourceStore } from "../../server/resources.js";
import { resolveComposerHistoryArtifacts } from "../../server/runtime-composer-artifacts.js";
import {
  effectiveRuntimeLeaf,
  type RuntimeSlot,
} from "../../server/runtime-slot.js";
import { SessionProjection } from "../../server/session-projection.js";
import {
  composerArtifactReference,
  parseComposerArtifactReference,
} from "../../shared/composer-artifact-references.js";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
} from "../../shared/contracts.js";
import {
  disposeRuntimeFixture,
  fixtureWorkspace,
  initializeRuntimeFixture,
  record as sessionRecord,
} from "./fixtures/runtime.js";
import { jsonl, messageEntry, writeSession } from "./fixtures/session-jsonl.js";

afterEach(disposeRuntimeFixture);

const owner = {
  sessionId: "session-a",
  revision: 7,
  viewId: "view-a",
  incarnation: "projection-a",
  effectiveLeafId: "leaf-a",
  composerHistoryVersion: "history-a",
};
const user = (id: string, content: unknown) => ({
  __inspireHistoryEntryId: id,
  role: "user",
  content,
});
const image = (mimeType: string) => ({
  type: "image",
  mimeType,
  data: "cGl4ZWxz",
});

it("retains newest-first user prompts and drops only consecutive duplicate entries", () => {
  expect(
    composerHistoryEntries([
      user("one-again", "one"),
      user("blank", "   "),
      user("two-repeat", "two parts"),
      user("two-first", [
        { type: "text", text: "two" },
        { type: "text", text: " parts" },
      ]),
      {
        __inspireHistoryEntryId: "answer",
        role: "assistant",
        content: "not a prompt",
      },
      user("one-first", "  one  "),
    ]),
  ).toEqual(
    ["one", "two parts", "one"].map((text) => ({
      text,
      images: [],
      files: [],
    })),
  );
});

it("skips projection of artifacts outside the retained prompt limit", () => {
  function* recent() {
    for (let index = MAX_COMPOSER_HISTORY_ENTRIES; index >= 0; index--)
      yield user(String(index), `recent-${index}`);
    throw new Error("Obsolete prompts should not be visited");
  }
  const history = composerHistoryEntries(recent());
  expect(history).toHaveLength(MAX_COMPOSER_HISTORY_ENTRIES);
  expect(history[0]?.text).toBe(`recent-${MAX_COMPOSER_HISTORY_ENTRIES}`);
  expect(history.at(-1)?.text).toBe("recent-1");
});

it("recalls mixed and image-only prompts with original artifact coordinates and editable text", () => {
  const file = resolve("report.md");
  const note =
    "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";
  const source = addAttachmentContext("Inspect", [], [file]) + "\n\n" + note;
  const mixed = user("u/mixed", [
    { type: "text", text: source },
    image("image/png"),
  ]);
  const history = composerHistoryEntries([
    user("image-repeat", [image("image/webp")]),
    user("image-first", [image("image/webp")]),
    mixed,
  ]);
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    text: "",
    images: [{ mimeType: "image/webp", size: 6 }],
    files: [],
  });
  expect(history[1]).toEqual({
    text: "Inspect",
    images: [
      {
        reference: "pi-history-image://u%2Fmixed/1",
        mimeType: "image/png",
        size: 6,
      },
    ],
    files: [
      {
        reference: "pi-history-file://u%2Fmixed/0",
        fileName: "report.md",
        kind: "attachment",
      },
    ],
  });
  expect(mixed.content).toEqual([
    { type: "text", text: source },
    image("image/png"),
  ]);
});

it("recalls file-only prompts by readable Host names and keeps equal text with different files", () => {
  const workspace = resolve("/workspace");
  const stored = resolve("/cache/uploads/00000000-0000-4000-8000-report.pdf");
  const upload = (path: string) => ({ kind: "file" as const, path });
  const entries = composerHistoryEntries(
    [
      user(
        "file-only",
        addAttachmentContext(
          "",
          [upload(stored)],
          [join(workspace, "src", "source.ts")],
        ),
      ),
      user(
        "first",
        addAttachmentContext(
          "same text",
          [upload(resolve("/cache/uploads/first.txt"))],
          [],
        ),
      ),
      user(
        "second",
        addAttachmentContext(
          "same text",
          [upload(resolve("/cache/uploads/second.txt"))],
          [],
        ),
      ),
    ].reverse(),
    workspace,
    (path) => (path === stored ? "report.pdf" : null),
  );

  expect(entries.map(({ text, files }) => ({ text, files }))).toEqual([
    {
      text: "same text",
      files: [
        {
          reference: "pi-history-file://second/0",
          fileName: "second.txt",
          kind: "attachment",
        },
      ],
    },
    {
      text: "same text",
      files: [
        {
          reference: "pi-history-file://first/0",
          fileName: "first.txt",
          kind: "attachment",
        },
      ],
    },
    {
      text: "",
      files: [
        {
          reference: "pi-history-file://file-only/0",
          fileName: "source.ts",
          kind: "project",
        },
        {
          reference: "pi-history-file://file-only/1",
          fileName: "report.pdf",
          kind: "attachment",
        },
      ],
    },
  ]);
});

it("pages exact entries under one history identity and the serialized byte bound", () => {
  const texts = Array.from(
    { length: 100 },
    (_, index) => `${index}:${"\0".repeat(10_000)}`,
  );
  const messages = texts.map((text, index) => user(String(index), text));
  messages.reverse();
  let page = projectComposerHistoryPage(messages, owner);
  const historyId = page.historyId;
  expect(page.nextStart).not.toBeNull();
  const entries: string[] = [];
  for (;;) {
    expect(page.historyId).toBe(historyId);
    expect(page.start).toBe(entries.length);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      MAX_COMPOSER_HISTORY_PAGE_BYTES,
    );
    entries.push(...page.entries.map(({ text }) => text));
    if (page.nextStart === null) break;
    expect(page.nextStart).toBeGreaterThan(page.start);
    expect(page.nextStart).toBeLessThan(texts.length);
    page = projectComposerHistoryPage(messages, owner, page.nextStart);
  }
  expect(entries).toEqual(texts.reverse());
});

it("accepts canonical history coordinates and rejects a different resource namespace", () => {
  const reference = composerArtifactReference("image", "u/中文", 3);
  expect(parseComposerArtifactReference("image", reference)).toEqual([
    "u/中文",
    3,
  ]);
  for (const invalid of [
    composerArtifactReference("file", "u/中文", 3),
    "pi-embedded://2/3",
    "pi-history-image://%zz/0",
    "pi-history-image://%75ser/0",
    "pi-history-image://user/-1",
    "pi-history-image://user/01",
    "pi-history-image://user/9007199254740992",
  ]) {
    expect(parseComposerArtifactReference("image", invalid)).toBeNull();
  }
});

it("recalls retained branch prompts and exact artifacts through live compaction, cold reopen, and navigation", async () => {
  await initializeRuntimeFixture();
  const cwd = join(fixtureWorkspace, "project");
  const projectFile = join(cwd, "source.ts");
  const ownedFile = join(fixtureWorkspace, "upload.pdf");
  await writeFile(projectFile, "project");
  await writeFile(ownedFile, "upload");
  const path = join(fixtureWorkspace, "session.jsonl");
  const id = "history-test";
  const userEntry = (
    id: string,
    parentId: string | null,
    text: string,
    pixels: string,
  ) =>
    messageEntry(id, parentId, {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text },
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(pixels).toString("base64"),
        },
      ],
    });
  const u1 = userEntry(
    "u/1",
    null,
    addAttachmentContext(
      "original",
      [{ kind: "file", path: ownedFile }],
      [projectFile],
    ),
    "original image",
  );
  const answer = messageEntry("a1", u1.id, {
    role: "assistant",
    timestamp: 2,
    content: [{ type: "text", text: "answer" }],
  });
  await writeSession(path, cwd, id, [u1, answer]);
  const record = { ...sessionRecord(id, cwd), path };
  let projection = await SessionProjection.open(record);
  const resources = new ResourceStore();
  const slot = {
    id,
    cwd,
    viewId: "view-original",
    workerView: null,
    projection,
  } as unknown as RuntimeSlot;
  const page = () =>
    projection.historyPage(
      { kind: "composer", start: 0 },
      effectiveRuntimeLeaf(slot),
      slot.viewId,
      cwd,
    );
  const request = (entry: ReturnType<typeof page>["entries"][number]) => ({
    sessionId: id,
    message: "recall",
    historyArtifacts: {
      viewId: slot.viewId,
      incarnation: projection.incarnation,
      effectiveLeafId: effectiveRuntimeLeaf(slot),
      imageReferences: entry.images.map((image) => image.reference),
      fileReferences: entry.files.map((file) => file.reference),
    },
  });
  const restage = (
    input: ReturnType<typeof request>,
    ownsPromptFile: (path: string) => boolean = (file) => file === ownedFile,
  ) =>
    resolveComposerHistoryArtifacts(slot, input, {
      ready: async () => {},
      ownsPromptFile,
    });
  const append = async (entry: unknown) => {
    await appendFile(path, jsonl(entry));
    await projection.reconcile(true);
  };
  try {
    const original = page();
    expect(original.entries[0]?.images[0]?.reference).toBe(
      "pi-history-image://u%2F1/1",
    );
    await append({
      type: "compaction",
      id: "c1",
      parentId: "a1",
      firstKeptEntryId: "c1",
      summary: "summary",
      tokensBefore: 1000,
      timestamp: new Date(3).toISOString(),
    });
    expect(page().entries).toEqual(original.entries);
    expect(page().historyId).toBe(original.historyId);
    expect(page().composerHistoryVersion).toBe(original.composerHistoryVersion);
    expect(
      projection
        .viewMessages()
        .some((value) => (value as { role: string }).role === "user"),
    ).toBe(false);
    await projection.close();
    projection = await SessionProjection.open(record);
    slot.projection = projection;
    expect(page().entries).toEqual(original.entries);

    await append(userEntry("u2", "c1", "later", "different image"));
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "later",
      "original",
    ]);
    const recalled = page().entries[1]!;
    await expect(restage(request(recalled))).resolves.toMatchObject({
      images: [
        {
          data: Buffer.from("original image").toString("base64"),
          mimeType: "image/png",
        },
      ],
      files: [{ kind: "file", path: ownedFile }],
      projectFiles: [projectFile],
    });
    await expect(restage(request(recalled), () => false)).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    const context = {
      sessionId: id,
      viewId: slot.viewId,
      revision: projection.revision,
      cwd,
      messages: [
        ...projection.viewMessages(),
        ...projection.composerHistoryMessages(),
      ],
    };
    for (const [reference, expected] of [
      [recalled.images[0]!.reference, "original image"],
      ["pi-embedded://1/1", "different image"],
    ] as const) {
      const descriptor = await resources.resolve(context, reference);
      const { data } = await resources.embeddedContent(
        resources.get(descriptor.id, id, slot.viewId),
        context,
      );
      expect(data.toString()).toBe(expected);
    }
    const oldAuthority = request(page().entries[0]!);
    await append(userEntry("alternate", "a1", "other branch", "branch image"));
    slot.viewId = "view-other";
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "other branch",
      "original",
    ]);
    await expect(restage(oldAuthority)).rejects.toMatchObject({ status: 409 });
    const forged = request(page().entries[0]!);
    forged.historyArtifacts.imageReferences = ["pi-history-image://u2/1"];
    forged.historyArtifacts.fileReferences = [];
    await expect(restage(forged)).rejects.toMatchObject({ status: 409 });
    slot.viewLeafId = "u2";
    slot.viewId = "view-earlier";
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "later",
      "original",
    ]);
    await expect(restage(request(page().entries[1]!))).resolves.toMatchObject({
      projectFiles: [projectFile],
    });
    slot.viewLeafId = null;
    expect(page().entries).toEqual([]);
    await expect(restage(request(recalled))).rejects.toMatchObject({
      status: 409,
    });
  } finally {
    await projection.close();
    await resources.close();
  }
});
