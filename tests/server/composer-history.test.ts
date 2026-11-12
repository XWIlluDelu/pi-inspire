import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";
import {
  composerHistoryEntries,
  projectComposerHistoryPage,
} from "../../server/composer-history.js";
import { ResourceStore } from "../../server/resources.js";
import { resolveComposerHistoryArtifacts } from "../../server/runtime-composer-artifacts.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { SessionProjection } from "../../server/session-projection.js";
import {
  composerArtifactReference,
  parseComposerArtifactReference,
} from "../../shared/composer-artifact-references.js";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
} from "../../shared/contracts.js";

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
      user("one-first", "  one  "),
      {
        __inspireHistoryEntryId: "answer",
        role: "assistant",
        content: "not a prompt",
      },
      user("two-first", [
        { type: "text", text: "two" },
        { type: "text", text: " parts" },
      ]),
      user("two-repeat", "two parts"),
      user("blank", "   "),
      user("one-again", "one"),
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
  const obsolete = {
    ...user("obsolete", ""),
    get content(): string {
      throw new Error("Obsolete artifacts should not be projected");
    },
  };
  const recent = Array.from(
    { length: MAX_COMPOSER_HISTORY_ENTRIES + 1 },
    (_, index) => user(String(index), `recent-${index}`),
  );
  const history = composerHistoryEntries([obsolete, ...recent]);
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
    mixed,
    user("image-first", [image("image/webp")]),
    user("image-repeat", [image("image/webp")]),
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
    ],
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
    "pi-history-image://user/9007199254740992",
  ]) {
    expect(parseComposerArtifactReference("image", invalid)).toBeNull();
  }
});

it("recalls retained branch prompts and exact artifacts through live compaction, cold reopen, and navigation", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-history-retention-")),
  );
  const cwd = join(root, "project");
  await mkdir(cwd);
  const projectFile = join(cwd, "source.ts");
  const ownedFile = join(root, "upload.pdf");
  await writeFile(projectFile, "project");
  await writeFile(ownedFile, "upload");
  const path = join(root, "session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "history-test",
    cwd,
    timestamp: new Date(0).toISOString(),
  };
  const userEntry = (
    id: string,
    parentId: string | null,
    text: string,
    pixels: string,
  ) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(1).toISOString(),
    message: {
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
    },
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
  const answer = {
    type: "message",
    id: "a1",
    parentId: u1.id,
    timestamp: new Date(2).toISOString(),
    message: {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "answer" }],
    },
  };
  await writeFile(
    path,
    [header, u1, answer].map((entry) => JSON.stringify(entry)).join("\n") +
      "\n",
  );
  const record = {
    id: header.id,
    path,
    cwd,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 2,
    firstMessage: "",
  } as SessionRecord;
  let projection = await SessionProjection.open(record);
  const resources = new ResourceStore();
  const slot = {
    id: header.id,
    cwd,
    viewId: "view-original",
    navigationLease: null,
    projection,
  } as unknown as RuntimeSlot;
  const page = () =>
    projection.composerHistoryPage(
      0,
      slot.navigationLease?.effectiveLeafId ?? projection.leafId,
      slot.viewId,
      cwd,
    );
  const request = (entry: ReturnType<typeof page>["entries"][number]) => ({
    sessionId: header.id,
    message: "recall",
    historyArtifacts: {
      viewId: slot.viewId,
      incarnation: projection.incarnation,
      effectiveLeafId:
        slot.navigationLease?.effectiveLeafId ?? projection.leafId,
      imageReferences: entry.images.map((image) => image.reference),
      fileReferences: entry.files.map((file) => file.reference),
    },
  });
  try {
    const original = page();
    expect(original.entries[0]?.images[0]?.reference).toBe(
      "pi-history-image://u%2F1/1",
    );
    const compact = {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      firstKeptEntryId: "c1",
      summary: "summary",
      tokensBefore: 1000,
      timestamp: new Date(3).toISOString(),
    };
    await appendFile(path, JSON.stringify(compact) + "\n");
    await projection.reconcile(true);
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

    const later = userEntry("u2", "c1", "later", "different image");
    await appendFile(path, JSON.stringify(later) + "\n");
    await projection.reconcile(true);
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "later",
      "original",
    ]);
    const recalled = page().entries[1]!;
    const resolved = await resolveComposerHistoryArtifacts(
      slot,
      request(recalled),
      { ready: async () => {}, ownsPromptFile: (file) => file === ownedFile },
    );
    expect(resolved).toMatchObject({
      images: [
        {
          data: Buffer.from("original image").toString("base64"),
          mimeType: "image/png",
        },
      ],
      files: [{ kind: "file", path: ownedFile }],
      projectFiles: [projectFile],
    });
    await expect(
      resolveComposerHistoryArtifacts(slot, request(recalled), {
        ready: async () => {},
        ownsPromptFile: () => false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const context = {
      sessionId: header.id,
      viewId: slot.viewId,
      revision: projection.revision,
      cwd,
      messages: [
        ...projection.viewMessages(),
        ...projection.composerHistoryMessages(),
      ],
    };
    const descriptor = await resources.resolve(
      context,
      recalled.images[0]!.reference,
    );
    expect(
      (
        await resources.embeddedContent(
          resources.get(descriptor.id, header.id, slot.viewId),
          context,
        )
      ).data.toString(),
    ).toBe("original image");
    const visible = await resources.resolve(context, "pi-embedded://1/1");
    expect(
      (
        await resources.embeddedContent(
          resources.get(visible.id, header.id, slot.viewId),
          context,
        )
      ).data.toString(),
    ).toBe("different image");
    const oldAuthority = request(page().entries[0]!);
    const alternate = userEntry(
      "alternate",
      "a1",
      "other branch",
      "branch image",
    );
    await appendFile(path, JSON.stringify(alternate) + "\n");
    await projection.reconcile(true);
    slot.viewId = "view-other";
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "other branch",
      "original",
    ]);
    await expect(
      resolveComposerHistoryArtifacts(slot, oldAuthority, {
        ready: async () => {},
        ownsPromptFile: () => true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const forged = request(page().entries[0]!);
    forged.historyArtifacts.imageReferences = ["pi-history-image://u2/1"];
    forged.historyArtifacts.fileReferences = [];
    await expect(
      resolveComposerHistoryArtifacts(slot, forged, {
        ready: async () => {},
        ownsPromptFile: () => true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    slot.navigationLease = {
      effectiveLeafId: "u2",
    } as RuntimeSlot["navigationLease"];
    slot.viewId = "view-earlier";
    expect(page().entries.map((entry) => entry.text)).toEqual([
      "later",
      "original",
    ]);
    await expect(
      resolveComposerHistoryArtifacts(slot, request(page().entries[1]!), {
        ready: async () => {},
        ownsPromptFile: (file) => file === ownedFile,
      }),
    ).resolves.toMatchObject({ projectFiles: [projectFile] });
  } finally {
    await projection.close();
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});
