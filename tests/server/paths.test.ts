import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectDirectory,
  escapesBase,
  resolveProjectDirectory,
} from "../../server/paths.js";

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(os.homedir) };
});

describe("path containment", () => {
  it("distinguishes traversal from valid names beginning with two dots", () => {
    expect(escapesBase("")).toBe(false);
    expect(escapesBase("..notes/file.ts")).toBe(false);
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
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("observes a missing home-relative project before explicitly creating it", async () => {
    vi.mocked(homedir).mockReturnValue(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await expect(resolveProjectDirectory("~")).resolves.toBe(
      await realpath(root),
    );
    const spelling = sep === "\\" ? "~\\projects\\new" : "~/projects/new";
    const target = join(root, "projects", "new");
    await expect(resolveProjectDirectory(spelling)).rejects.toMatchObject({
      status: 400,
      code: "PROJECT_DIRECTORY_MISSING",
    });
    await expect(stat(join(root, "projects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const canonical = await createProjectDirectory(spelling);
    expect(canonical).toBe(await realpath(target));
    await expect(resolveProjectDirectory(spelling)).resolves.toBe(canonical);
    await writeFile(join(target, "keep.txt"), "unchanged");
    expect(await createProjectDirectory(spelling)).toBe(canonical);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("unchanged");
    await expect(stat(join(root, "~"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a literal tilde component when the user supplies an explicit absolute path", async () => {
    vi.mocked(homedir).mockReturnValue(root);
    const target = join(root, "~", "literal");
    await mkdir(target, { recursive: true });
    await expect(resolveProjectDirectory(target)).resolves.toBe(
      await realpath(target),
    );
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
