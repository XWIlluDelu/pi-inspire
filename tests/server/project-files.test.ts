import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateProjectFiles,
  listProjectDirectory,
  searchProjectFiles,
  workspaceBasenameMatches,
} from "../../server/project-files.js";
import * as hidden from "../../server/host-hidden-dirs.js";
import * as git from "../../server/git-runner.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const exec = promisify(execFile);
const roots: string[] = [];
async function scratch() {
  const root = await fs.mkdtemp(join(tmpdir(), "inspire-filesystem-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  invalidateProjectFiles("");
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("filesystem discovery, independent of Git", () => {
  // APFS and Windows cannot create this raw-byte filename. Keep the real
  // filesystem regression on Linux instead of failing during fixture setup.
  it.runIf(process.platform === "linux")(
    "does not alias non-UTF-8 filenames to real replacement-character filenames",
    async () => {
      const root = await scratch();
      await fs.writeFile(
        Buffer.concat([
          Buffer.from(`${root}/`),
          Buffer.from([255]),
          Buffer.from(".txt"),
        ]),
        "invalid UTF-8 fixture",
      );
      await fs.writeFile(join(root, "�.txt"), "valid UTF-8 fixture");
      await fs.writeFile(join(root, "中文.txt"), "valid UTF-8 fixture");
      const listed = await listProjectDirectory(root);
      expect(listed.truncated).toBe(true);
      expect(listed.entries).toHaveLength(2);
      expect(listed.entries).toEqual(
        expect.arrayContaining([
          { name: "�.txt", type: "file" },
          { name: "中文.txt", type: "file" },
        ]),
      );
    },
  );

  it("bounds directory enumeration and explicitly reports incomplete results", async () => {
    const root = await scratch();
    vi.mocked(fs.opendir).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 10_001; index++)
          yield {
            name: `file-${index}`,
            isDirectory: () => false,
            isFile: () => true,
          };
      },
    } as unknown as Awaited<ReturnType<typeof fs.opendir>>);
    const result = await listProjectDirectory(root);
    expect(result.entries).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
  });

  it.each([false, true])(
    "lists actual directories and applies only hidden visibility (git=%s)",
    async (repository) => {
      const root = await scratch();
      for (const name of ["empty", "dist", "node_modules", ".config"])
        await fs.mkdir(join(root, name));
      for (const name of [
        "plain.txt",
        "ignored.txt",
        ".env",
        "..notes",
        "dist/report.txt",
        "node_modules/package.txt",
        ".config/settings.json",
      ])
        await fs.writeFile(join(root, name), "fixture");
      await fs.writeFile(
        join(root, ".gitignore"),
        "ignored.txt\ndist/\nnode_modules/\n",
      );
      if (repository) {
        await exec("git", ["-C", root, "init", "-q"]);
        await exec("git", ["-C", root, "add", ".env", "plain.txt"]);
        await fs.writeFile(join(root, ".git", "index"), "invalid git index");
      }
      const runner = vi.spyOn(git, "spawnGit");
      expect(await listProjectDirectory(root)).toEqual({
        entries: [
          { name: "dist", type: "dir" },
          { name: "empty", type: "dir" },
          { name: "node_modules", type: "dir" },
          { name: "ignored.txt", type: "file" },
          { name: "plain.txt", type: "file" },
        ],
        truncated: false,
      });
      expect(await listProjectDirectory(root, "empty")).toEqual({
        entries: [],
        truncated: false,
      });
      expect(
        (await listProjectDirectory(root, "", true)).entries,
      ).toContainEqual({ name: ".env", type: "file" });
      expect(
        (await searchProjectFiles(root)).files.map((file) => file.path),
      ).toEqual(
        expect.arrayContaining([
          "ignored.txt",
          "dist/report.txt",
          "node_modules/package.txt",
        ]),
      );
      expect((await searchProjectFiles(root, ".env")).files).toEqual([]);
      expect((await searchProjectFiles(root, ".env", 50, true)).files).toEqual([
        { path: ".env", name: ".env" },
      ]);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("uses native hidden attributes and bypasses their inspection only when requested", async () => {
    const root = await scratch();
    await fs.mkdir(join(root, "native-hidden"));
    await fs.writeFile(join(root, "flagged.txt"), "fixture");
    const attributes = vi
      .spyOn(hidden, "listNativeHiddenNames")
      .mockResolvedValue(new Set(["native-hidden", "flagged.txt"]));
    expect((await listProjectDirectory(root)).entries).toEqual([]);
    expect((await listProjectDirectory(root, "", true)).entries).toHaveLength(
      2,
    );
    expect(attributes).toHaveBeenCalledTimes(1);
    attributes.mockRejectedValue(new Error("attribute read failed"));
    await expect(listProjectDirectory(root)).rejects.toThrow(
      "attribute read failed",
    );
  });

  it("reports a missing/non-directory root and rejects traversal", async () => {
    const root = await scratch();
    await fs.writeFile(join(root, "file"), "fixture");
    await expect(listProjectDirectory(root, "../")).rejects.toMatchObject({
      status: 400,
    });
    await expect(listProjectDirectory(root, root)).rejects.toMatchObject({
      status: 400,
    });
    await expect(listProjectDirectory(root, "file")).rejects.toMatchObject({
      status: 400,
    });
    await expect(searchProjectFiles(join(root, "missing"))).rejects.toThrow();
  });

  it("refreshes bounded discovery without using it as access authority", async () => {
    const root = await scratch();
    await fs.writeFile(join(root, "one.txt"), "fixture");
    await searchProjectFiles(root);
    await fs.writeFile(join(root, "two.txt"), "fixture");
    expect((await searchProjectFiles(root)).files).toHaveLength(1);
    // Directory levels are read on demand, not derived from a cached file index.
    expect((await listProjectDirectory(root)).entries).toHaveLength(2);
    invalidateProjectFiles(root);
    expect((await searchProjectFiles(root)).files).toHaveLength(2);
  });

  it("reports partial result limits and includes hidden files in explicit basename recovery", async () => {
    const root = await scratch();
    await fs.mkdir(join(root, ".hidden"));
    await fs.writeFile(join(root, ".hidden", "report.txt"), "fixture");
    await fs.writeFile(join(root, "one.txt"), "fixture");
    await fs.writeFile(join(root, "two.txt"), "fixture");
    expect(await searchProjectFiles(root, "", 1)).toMatchObject({
      truncated: true,
    });
    expect(await workspaceBasenameMatches(root, "report.txt")).toEqual({
      matches: [".hidden/report.txt"],
      truncated: false,
    });
    await fs.mkdir(join(root, "unreadable"));
    const original = (await vi.importActual<typeof fs>("node:fs/promises"))
      .opendir;
    vi.spyOn(fs, "opendir").mockImplementation((path, options) => {
      if (String(path).endsWith("unreadable"))
        return Promise.reject(new Error("unreadable fixture"));
      return original(path, options);
    });
    invalidateProjectFiles(root);
    expect(await workspaceBasenameMatches(root, "one.txt")).toMatchObject({
      matches: ["one.txt"],
      truncated: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "navigates in-workspace symlink directories (including cycles) without following outside targets",
    async () => {
      const root = await scratch();
      const outside = await scratch();
      await fs.mkdir(join(root, "module"));
      await fs.writeFile(join(root, "module", "source.txt"), "fixture");
      await fs.symlink("module", join(root, "linked"));
      await fs.symlink(".", join(root, "cycle"));
      await fs.symlink(outside, join(root, "outside"));
      expect((await listProjectDirectory(root)).entries).toContainEqual({
        name: "linked",
        type: "dir",
      });
      expect((await listProjectDirectory(root, "linked")).entries).toEqual([
        { name: "source.txt", type: "file" },
      ]);
      await expect(listProjectDirectory(root, "outside")).rejects.toMatchObject(
        { status: 403 },
      );
      expect((await searchProjectFiles(root)).files).toHaveLength(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves literal backslashes, newlines and dot-prefix names",
    async () => {
      const root = await scratch();
      for (const name of ["a\\b.txt", "line\nname.txt", "..notes"])
        await fs.writeFile(join(root, name), "fixture");
      expect(
        (await searchProjectFiles(root, "", 50, true)).files.map(
          (file) => file.path,
        ),
      ).toEqual(
        expect.arrayContaining(["a\\b.txt", "line\nname.txt", "..notes"]),
      );
    },
  );
});
