import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addAttachmentContext,
  resolveProjectFiles,
} from "../../server/attachments.js";
import {
  assertPromptArtifactBudget,
  resolveComposerHistoryArtifacts,
  revalidateProjectFiles,
} from "../../server/runtime-composer-artifacts.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("composer-history artifacts", () => {
  it("keeps an explicit root navigation separate from the durable leaf", async () => {
    const composerHistoryMessages = vi.fn(() => []);
    const slot = {
      viewId: "root-view",
      navigationLease: { effectiveLeafId: null },
      projection: {
        incarnation: "source-a",
        leafId: "durable-leaf",
        composerHistoryMessages,
      },
    } as unknown as RuntimeSlot;
    await resolveComposerHistoryArtifacts(
      slot,
      {
        sessionId: "session-a",
        message: "",
        historyArtifacts: {
          viewId: "root-view",
          incarnation: "source-a",
          effectiveLeafId: null,
          imageReferences: [],
          fileReferences: [],
        },
      },
      { ready: async () => {}, ownsPromptFile: () => false },
    );
    expect(composerHistoryMessages).toHaveBeenCalledWith(null);
  });

  it("rejects non-canonical or empty prompt image data before budgeting it", () => {
    for (const data of ["T Q==", ""]) {
      expect(() => assertPromptArtifactBudget(1, 0, [{ data }])).toThrow(
        "A prompt image is invalid",
      );
    }
  });

  it.each([false, true])(
    "retains Host-owned attachments inside the project (image hint: %s)",
    async (withImage) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "inspire-prompt-files-")),
      );
      roots.push(root);
      const attachment = join(root, "owned.txt");
      await writeFile(attachment, "owned attachment\n");
      const prompt = addAttachmentContext(
        "Use this file",
        [{ kind: "file", path: attachment }],
        [],
      );
      const slot = {
        cwd: root,
        viewId: "view-a",
        navigationLease: null,
        projection: {
          incarnation: "incarnation-a",
          leafId: null,
          composerHistoryMessages: () => [
            {
              role: "user",
              content: withImage
                ? [
                    {
                      type: "text",
                      text:
                        prompt +
                        "\n\n[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]",
                    },
                    { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
                  ]
                : prompt,
              __inspireHistoryEntryId: "entry-0",
            },
          ],
        },
      } as unknown as RuntimeSlot;

      await expect(
        resolveComposerHistoryArtifacts(
          slot,
          {
            sessionId: "session-a",
            message: "Use this file",
            historyArtifacts: {
              viewId: "view-a",
              incarnation: "incarnation-a",
              effectiveLeafId: null,
              imageReferences: [],
              fileReferences: ["pi-history-file://entry-0/0"],
            },
          },
          {
            ready: async () => {},
            ownsPromptFile: (path) => path === attachment,
          },
        ),
      ).resolves.toMatchObject({
        files: [{ kind: "file", path: attachment }],
        projectFiles: [],
      });
    },
  );
});

describe("prompt project-file revalidation", () => {
  it("accepts hidden and newly ignored project files at delivery and history recall", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-prompt-files-")),
    );
    roots.push(root);
    await mkdir(join(root, ".settings"));
    const selected = join(root, ".settings", "config.txt");
    await writeFile(selected, "synthetic configuration\n");
    const expected = await resolveProjectFiles(root, [selected]);
    await writeFile(join(root, ".gitignore"), ".settings/\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "index"), "invalid Git fixture");
    await expect(resolveProjectFiles(root, [".settings"])).rejects.toThrow(
      /not a regular file/,
    );
    await expect(
      revalidateProjectFiles(root, [selected], expected),
    ).resolves.toEqual(expected);
    const slot = {
      cwd: root,
      viewId: "view-a",
      navigationLease: null,
      projection: {
        incarnation: "incarnation-a",
        leafId: null,
        composerHistoryMessages: () => [
          {
            role: "user",
            content: addAttachmentContext("Use", [], expected),
            __inspireHistoryEntryId: "entry-0",
          },
        ],
      },
    } as unknown as RuntimeSlot;
    await expect(
      resolveComposerHistoryArtifacts(
        slot,
        {
          sessionId: "session-a",
          message: "Use",
          historyArtifacts: {
            viewId: "view-a",
            incarnation: "incarnation-a",
            effectiveLeafId: null,
            imageReferences: [],
            fileReferences: ["pi-history-file://entry-0/0"],
          },
        },
        { ready: async () => {}, ownsPromptFile: () => false },
      ),
    ).resolves.toMatchObject({ projectFiles: expected });
  });

  it("revalidates canonical project files before delivery and rejects retargeted selections", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-prompt-files-")),
    );
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const original = join(workspace, "first.txt");
    const replacement = join(workspace, "second.txt");
    const outside = join(root, "outside.txt");
    for (const file of [original, replacement, outside])
      await writeFile(file, file);

    const selected = join(workspace, "selected.txt");
    await symlink(original, selected);
    const expected = await resolveProjectFiles(workspace, ["selected.txt"]);
    await expect(
      revalidateProjectFiles(workspace, ["selected.txt", original], expected),
    ).resolves.toEqual([original]);

    for (const target of [replacement, outside]) {
      await rm(selected);
      await symlink(target, selected);
      await expect(
        revalidateProjectFiles(workspace, ["selected.txt"], expected),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
});
