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
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectFiles } from "../../server/attachments.js";
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
async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-prompt-files-")),
  );
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd };
}

it("revalidates one canonical file after Git changes and refuses symlink retargeting", async () => {
  const { root, cwd } = await workspace();
  const hidden = join(cwd, ".settings");
  await mkdir(hidden);
  await mkdir(join(cwd, ".git"));
  const file = join(hidden, "config.txt");
  const replacement = join(cwd, "replacement.txt");
  const outside = join(root, "outside.txt");
  await Promise.all(
    [file, replacement, outside].map((path) => writeFile(path, "fixture")),
  );
  const link = join(cwd, "selected.txt");
  await symlink(file, link);
  const expected = await resolveProjectFiles(cwd, ["selected.txt"]);
  await writeFile(join(cwd, ".gitignore"), ".settings/\n");
  await writeFile(join(cwd, ".git", "index"), "unreadable Git metadata");
  await expect(resolveProjectFiles(cwd, [".settings"])).rejects.toThrow(
    /not a regular file/,
  );
  await expect(
    revalidateProjectFiles(cwd, ["selected.txt", file], expected),
  ).resolves.toEqual([file]);
  for (const target of [replacement, outside]) {
    await rm(link);
    await symlink(target, link);
    await expect(
      revalidateProjectFiles(cwd, ["selected.txt"], expected),
    ).rejects.toMatchObject({ status: 409 });
  }
});

it("keeps an explicitly recalled root separate from the durable branch and rejects malformed image bytes", async () => {
  const composerHistoryMessages = vi.fn(() => []);
  const slot = {
    viewId: "root-view",
    viewLeafId: null,
    projection: {
      incarnation: "source-a",
      leafId: "durable-leaf",
      composerHistoryMessages,
    },
  } as unknown as RuntimeSlot;
  await resolveComposerHistoryArtifacts(
    slot,
    {
      sessionId: "a",
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
  expect(composerHistoryMessages).toHaveBeenCalledExactlyOnceWith(null);
  for (const data of ["T Q==", ""])
    expect(() => assertPromptArtifactBudget(1, 0, [{ data }])).toThrow(
      "A prompt image is invalid",
    );
});
