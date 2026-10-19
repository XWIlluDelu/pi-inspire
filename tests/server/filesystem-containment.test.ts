import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemRelativePath } from "../../server/filesystem-containment.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "inspire-containment-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("filesystem containment on the actual fixture volume", () => {
  it("contains canonical native paths, not a sibling with a common prefix", async () => {
    const base = join(root, "Project");
    const sibling = join(root, "Project-extra");
    await mkdir(base);
    await mkdir(sibling);
    await writeFile(join(base, "inside.txt"), "fixture");
    await writeFile(join(sibling, "outside.txt"), "fixture");
    expect(
      await filesystemRelativePath(
        base,
        await realpath(join(base, "inside.txt")),
      ),
    ).toBe("inside.txt");
    expect(
      await filesystemRelativePath(
        base,
        await realpath(join(sibling, "outside.txt")),
      ),
    ).toBeNull();
  });

  it.each([
    ["Project", "project"],
    ["Caf\u00e9", "Cafe\u0301"],
  ])(
    "uses the native volume's actual case/normalization semantics: %s",
    async (baseName, candidateName) => {
      const base = join(root, baseName);
      const candidate = join(root, candidateName);
      await mkdir(base);
      const alias = await stat(candidate).then(
        (info) => info,
        () => null,
      );
      if (!alias) {
        await mkdir(candidate);
        await writeFile(join(candidate, "private.txt"), "fixture");
        expect(
          await filesystemRelativePath(base, join(candidate, "private.txt")),
        ).toBeNull();
      } else {
        const original = await stat(base);
        expect(alias.ino).toBe(original.ino);
        expect(alias.dev).toBe(original.dev);
        await writeFile(join(candidate, "inside.txt"), "fixture");
        expect(
          await filesystemRelativePath(base, join(candidate, "inside.txt")),
        ).toBe("inside.txt");
      }
    },
  );
});
