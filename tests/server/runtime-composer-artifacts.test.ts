import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectFiles } from "../../server/attachments.js";
import { revalidateProjectFiles } from "../../server/runtime-composer-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prompt project-file revalidation", () => {
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
  });
});
