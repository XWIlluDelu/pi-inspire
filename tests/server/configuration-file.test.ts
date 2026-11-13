import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editConfigurationDocument,
  editConfigurationFile,
  readConfigurationFile,
} from "../../server/configuration-file.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let root: string;
const original = '{"value":"original"}\n';
const replacement = '{"value":"replacement"}\n';
const revision = async (path: string) =>
  (await readConfigurationFile({ path })).revision;
const edit = async (
  path: string,
  expectedRevision = undefined as string | undefined,
) =>
  editConfigurationFile(
    { path, expectedRevision: expectedRevision ?? (await revision(path)) },
    async () => replacement,
  );
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "inspire-config-edit-")),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Pi configuration editing", () => {
  it("saves a regular filename case alias on a native case-insensitive volume", async (context) => {
    const lower = join(root, "config.json");
    const upper = join(root, "CONFIG.JSON");
    await fs.writeFile(upper, original);
    if (
      !(await fs.access(lower).then(
        () => true,
        () => false,
      ))
    )
      return context.skip();
    await edit(lower);
    expect(await fs.readFile(upper, "utf8")).toBe(replacement);
  });

  it("creates a dangling symlink's missing target without replacing the link", async () => {
    const file = join(root, "config.json");
    const target = join(root, "managed", "config.json");
    await fs.symlink(target, file);
    await edit(file);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(replacement);
  });

  it.each(["before save", "during save"] as const)(
    "rejects a reviewed path retargeted %s even with identical contents",
    async (when) => {
      const file = join(root, "config.json");
      const initialTarget = join(root, "original.json");
      const changedTarget = join(root, "changed.json");
      await fs.writeFile(initialTarget, original);
      await fs.writeFile(changedTarget, original);
      await fs.symlink(initialTarget, file);
      const expectedRevision = await revision(file);
      const retarget = async () => {
        await fs.rm(file);
        await fs.symlink(changedTarget, file);
      };
      if (when === "before save") await retarget();
      await expect(
        editConfigurationFile({ path: file, expectedRevision }, async () => {
          if (when === "during save") await retarget();
          return replacement;
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(changedTarget, "utf8")).toBe(original);
      expect(await fs.readFile(initialTarget, "utf8")).toBe(original);
      for (const path of [file, initialTarget])
        await expect(fs.access(`${path}.lock`)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it("refuses a malformed reviewed document before applying a patch", async () => {
    const path = join(root, "config.json");
    await fs.writeFile(path, "{broken");
    const transform = vi.fn(() => ({ value: "replacement" }));
    await expect(
      editConfigurationDocument(
        { path, expectedRevision: await revision(path) },
        { invalid: "Repair the invalid document" },
        transform,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Repair the invalid document",
    });
    expect(transform).not.toHaveBeenCalled();
    expect(await fs.readFile(path, "utf8")).toBe("{broken");
  });

  it("recovers an abandoned native-compatible lock", async () => {
    const file = join(root, "config.json");
    const lock = `${file}.lock`;
    await fs.writeFile(file, original);
    await fs.mkdir(lock);
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lock, old, old);
    await edit(file);
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });

  it("allows only one competing save from the same reviewed revision", async () => {
    const file = join(root, "config.json");
    await fs.writeFile(file, original);
    const expected = await revision(file);
    const results = await Promise.allSettled([
      edit(file, expected),
      edit(file, expected),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });

  it("preserves an external change and releases every lock when temporary cleanup also fails", async () => {
    const file = join(root, "config.json");
    const related = join(root, "related.json");
    const external = '{"value":"external"}\n';
    await fs.writeFile(file, original);
    await fs.writeFile(related, original);
    const cleanupFailure = Object.assign(
      new Error("temporary file cleanup failed"),
      { code: "EACCES" },
    );
    const cleanup = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupFailure);
    await expect(
      editConfigurationFile(
        {
          path: file,
          expectedRevision: await revision(file),
          alsoLock: [{ path: related }],
        },
        async () => {
          await fs.writeFile(file, external);
          return replacement;
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed elsewhere"),
    });
    expect(cleanup).toHaveBeenCalled();
    cleanup.mockRestore();
    expect(await fs.readFile(file, "utf8")).toBe(external);
    for (const path of [file, related])
      await expect(fs.access(`${path}.lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    await Promise.all([edit(file), edit(related)]);
  });
});
