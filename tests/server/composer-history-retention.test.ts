import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";
import { ResourceStore } from "../../server/resources.js";
import { resolveComposerHistoryArtifacts } from "../../server/runtime-composer-artifacts.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { SessionProjection } from "../../server/session-projection.js";

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
  const user = (
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
  const u1 = user(
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
    searchText: "",
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

    const later = user("u2", "c1", "later", "different image");
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
    // Visible transcript images keep their original context-index namespace.
    const visible = await resources.resolve(context, "pi-embedded://1/1");
    expect(
      (
        await resources.embeddedContent(
          resources.get(visible.id, header.id, slot.viewId),
          context,
        )
      ).data.toString(),
    ).toBe("different image");
    await expect(
      resolveComposerHistoryArtifacts(
        slot,
        {
          ...request(recalled),
          historyArtifacts: {
            ...request(recalled).historyArtifacts,
            imageReferences: ["pi-embedded://0/1"],
            fileReferences: [],
          },
        },
        { ready: async () => {}, ownsPromptFile: () => true },
      ),
    ).rejects.toMatchObject({ status: 409 });

    const oldAuthority = request(page().entries[0]!);
    const alternate = user("alternate", "a1", "other branch", "branch image");
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
