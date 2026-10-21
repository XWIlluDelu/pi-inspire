import {
  access,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configurationEditLockPaths } from "../../server/configuration-edit-locks.js";

let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-config-authorities-")),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("configuration edit lock authorities", () => {
  it("uses the native target spelling of a regular file (canonicalization contract)", async () => {
    const lexical = join(root, "models.json");
    await writeFile(lexical, "{}");
    // Supply a case-canonicalized native target, without pretending the test
    // volume itself aliases these spellings. Native-volume saves live in each
    // configuration service's tests.
    const target = join(root, "MODELS.JSON");
    expect(await configurationEditLockPaths(lexical, target)).toEqual([target]);
  });

  it("retains both lexical and target locks for live and dangling symlinks", async () => {
    const lexical = join(root, "models.json");
    const target = join(root, "managed.json");
    await writeFile(target, "{}");
    await symlink(target, lexical);
    const expected = [lexical, target].sort();
    expect(await configurationEditLockPaths(lexical, target)).toEqual(expected);
    await rm(target);
    expect(await configurationEditLockPaths(lexical, target)).toEqual(expected);
  });

  it("retains missing/non-file authorities and propagates inspection errors", async () => {
    const missing = join(root, "new.json");
    expect(await configurationEditLockPaths(missing, missing)).toEqual([
      missing,
    ]);
    const directory = join(root, "directory");
    await mkdir(directory);
    // Do not treat any existing final component as proof of a regular file.
    expect(await configurationEditLockPaths(directory, missing)).toEqual(
      [directory, missing].sort(),
    );
    await expect(configurationEditLockPaths("\0", missing)).rejects.toThrow();
  });

  it("keeps distinct native case-sensitive filenames separate", async (context) => {
    const lower = join(root, "models.json");
    const upper = join(root, "MODELS.JSON");
    await writeFile(lower, "{}");
    if (
      await access(upper).then(
        () => true,
        () => false,
      )
    )
      return context.skip();
    await writeFile(upper, "{}");
    expect(
      await configurationEditLockPaths(lower, await realpath(lower)),
    ).toEqual([lower]);
    expect(
      await configurationEditLockPaths(upper, await realpath(upper)),
    ).toEqual([upper]);
  });

  it("does not merge hardlinked files into a shared file-inode authority", async () => {
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    await writeFile(first, "{}");
    await link(first, second);
    expect(
      await configurationEditLockPaths(first, await realpath(first)),
    ).toEqual([first]);
    expect(
      await configurationEditLockPaths(second, await realpath(second)),
    ).toEqual([second]);
  });
});
