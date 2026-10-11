import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectDirectory,
  escapesBase,
  resolveProjectDirectory,
} from "../../server/paths.js";

describe("path containment", () => {
  it("distinguishes traversal from valid names beginning with two dots", () => {
    expect(escapesBase("")).toBe(false);
    expect(escapesBase("src/file.ts")).toBe(false);
    expect(escapesBase("..notes/file.ts")).toBe(false);
    expect(escapesBase(".../file.ts")).toBe(false);
    expect(escapesBase("..")).toBe(true);
    expect(escapesBase("../secret.txt")).toBe(true);
    expect(escapesBase("..\\secret.txt")).toBe(true);
    expect(escapesBase(resolve("/tmp/secret.txt"))).toBe(true);
  });
});

describe("prospective project directories", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inspire-project-path-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("observes missing paths without creating them, then explicitly creates nested directories", async () => {
    const target = join(root, "projects", "new-project");
    await expect(resolveProjectDirectory(target)).rejects.toMatchObject({
      status: 400,
      code: "PROJECT_DIRECTORY_MISSING",
    });
    await expect(stat(join(root, "projects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const canonical = await createProjectDirectory(target);
    expect(canonical).toBe(await realpath(target));
    expect((await stat(canonical)).isDirectory()).toBe(true);
    // An intervening successful creation is harmless; existing contents remain.
    await writeFile(join(target, "keep.txt"), "unchanged");
    expect(await createProjectDirectory(target)).toBe(canonical);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("unchanged");
  });

  it.each(["target", "ancestor"] as const)(
    "rejects a file at the %s rather than offering creation",
    async (kind) => {
      const file = join(root, "file");
      await writeFile(file, "original");
      const target = kind === "target" ? file : join(file, "project");
      for (const operation of [
        resolveProjectDirectory,
        createProjectDirectory,
      ]) {
        const error = await operation(target).catch((error: unknown) => error);
        expect(error).toMatchObject({
          status: 400,
          message: "Project path is not a directory",
        });
        expect(error).not.toHaveProperty("code", "PROJECT_DIRECTORY_MISSING");
      }
      expect(await readFile(file, "utf8")).toBe("original");
    },
  );
});
