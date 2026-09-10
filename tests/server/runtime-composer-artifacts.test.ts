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
import { afterEach, describe, expect, it } from "vitest";
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
  it("rejects non-canonical or empty prompt image data before budgeting it", () => {
    for (const data of ["T Q==", ""]) {
      expect(() => assertPromptArtifactBudget(1, 0, [{ data }])).toThrow(
        "A prompt image is invalid",
      );
    }
  });

  it("retains Host-owned attachments even when the project root contains the upload path", async () => {
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
        viewMessages: () => [
          {
            role: "user",
            content: prompt,
            __inspireMessageIndex: 0,
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
            fileReferences: ["pi-file://0/0"],
          },
        },
        { ownsPromptFile: (path) => path === attachment },
      ),
    ).resolves.toMatchObject({
      files: [{ kind: "file", path: attachment }],
      projectFiles: [],
    });
  });
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
        viewMessages: () => [
          {
            role: "user",
            content: addAttachmentContext("Use", [], expected),
            __inspireMessageIndex: 0,
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
            fileReferences: ["pi-file://0/0"],
          },
        },
        { ownsPromptFile: () => false },
      ),
    ).resolves.toMatchObject({ projectFiles: expected });
  });

  it("still refuses an in-workspace symlink retarget between selection and delivery", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-prompt-files-")),
    );
    roots.push(root);
    for (const name of ["first.txt", "second.txt"])
      await writeFile(join(root, name), name);
    await symlink(join(root, "first.txt"), join(root, "selected.txt"));
    const expected = await resolveProjectFiles(root, ["selected.txt"]);
    await rm(join(root, "selected.txt"));
    await symlink(join(root, "second.txt"), join(root, "selected.txt"));
    await expect(
      revalidateProjectFiles(root, ["selected.txt"], expected),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a selected path replaced by an outside symlink before delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-prompt-files-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const selected = join(workspace, "source.ts");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(selected, "export const safe = true;\n");
    await writeFile(outside, "outside\n");

    const expected = await resolveProjectFiles(workspace, ["source.ts"]);
    await rm(selected);
    await symlink(outside, selected);

    await expect(
      revalidateProjectFiles(workspace, ["source.ts"], expected),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns freshly authorized canonical paths when they are unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-prompt-files-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const selected = join(workspace, "source.ts");
    await mkdir(workspace);
    await writeFile(selected, "export const safe = true;\n");

    const expected = await resolveProjectFiles(workspace, ["source.ts"]);
    await expect(
      revalidateProjectFiles(workspace, ["source.ts"], expected),
    ).resolves.toEqual(expected);
    await expect(
      revalidateProjectFiles(workspace, ["source.ts", selected], expected),
    ).resolves.toEqual(expected);
  });
});
