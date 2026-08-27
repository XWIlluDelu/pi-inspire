import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  directoryEntries,
  invalidateProjectIndex,
  isIndexedProjectFile,
  searchProjectFiles,
} from "../../server/project-files.js";

const execFileAsync = promisify(execFile);

describe("directoryEntries", () => {
  it("derives one directory level from the flat project index, folders first", () => {
    const paths = [
      "src/main.ts",
      "src/lib/util.ts",
      "README.md",
      "assets/logo.png",
    ];
    expect(directoryEntries(paths, "")).toEqual([
      { name: "assets", type: "dir" },
      { name: "src", type: "dir" },
      { name: "README.md", type: "file" },
    ]);
    expect(directoryEntries(paths, "src")).toEqual([
      { name: "lib", type: "dir" },
      { name: "main.ts", type: "file" },
    ]);
    expect(directoryEntries(paths, "src/lib")).toEqual([
      { name: "util.ts", type: "file" },
    ]);
    expect(directoryEntries(paths, "missing")).toEqual([]);
  });

  it("never treats the requested dir as a filesystem path", () => {
    // A traversal-looking dir simply matches no indexed prefix.
    expect(directoryEntries(["src/main.ts"], "../etc")).toEqual([]);
  });
});

describe("project index authority", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inspire-index-"));
    roots.push(root);
    return root;
  }

  it("surfaces a non-directory project root instead of reporting an empty project", async () => {
    const root = await scratch();
    const file = join(root, "not-a-directory");
    await writeFile(file, "content\n");

    await expect(searchProjectFiles(file, "", 100)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("keeps hidden files and credential trees out of the non-git fallback", async () => {
    const root = await scratch();
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE\n");
    await writeFile(join(root, "app.js"), "code\n");

    const results = await searchProjectFiles(root, "", 100);
    expect(results.map((item) => item.path)).toEqual(["app.js"]);
  });

  it("fails closed when git exists but the index command fails", async () => {
    const root = await scratch();
    await writeFile(join(root, "app.js"), "code\n");
    // A stub git that confirms the work tree but cannot list it models
    // timeouts and buffer overflows: never fall back to the wide walker.
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *rev-parse*) echo true; exit 0;; *) echo boom >&2; exit 1;; esac\n',
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await expect(searchProjectFiles(root, "", 100)).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("does not widen to the filesystem after an incompatible Git probe", async () => {
    const root = await scratch();
    await writeFile(join(root, "app.js"), "code\n");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *rev-parse*) echo unexpected; exit 0;; *) echo boom >&2; exit 1;; esac\n',
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await expect(searchProjectFiles(root, "", 100)).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("rejects byte-distinct git paths that cannot be represented as UTF-8", async () => {
    const root = await scratch();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *rev-parse*) echo true;; *) printf "\\377\\0";; esac\n',
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await expect(searchProjectFiles(root)).rejects.toThrow(/valid UTF-8/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("keeps a bounded cache entry per active workspace instead of thrashing", async () => {
    const first = await scratch();
    const second = await scratch();
    await writeFile(join(first, "one.txt"), "one\n");
    await writeFile(join(second, "other.txt"), "other\n");

    expect((await searchProjectFiles(first)).map((item) => item.path)).toEqual([
      "one.txt",
    ]);
    await searchProjectFiles(second);
    await writeFile(join(first, "two.txt"), "two\n");
    expect((await searchProjectFiles(first)).map((item) => item.path)).toEqual([
      "one.txt",
    ]);

    invalidateProjectIndex(first);
    expect((await searchProjectFiles(first)).map((item) => item.path)).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });

  it("invalidates a canonical cache after a bounded symlink alias is forgotten", async () => {
    const project = await scratch();
    const aliases = await scratch();
    await writeFile(join(project, "one.txt"), "one\n");
    const paths: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const alias = join(aliases, `project-${index}`);
      await symlink(project, alias);
      paths.push(alias);
      await searchProjectFiles(alias);
    }
    await writeFile(join(project, "two.txt"), "two\n");

    invalidateProjectIndex(paths[0]!);

    expect(
      (await searchProjectFiles(project)).map((item) => item.path),
    ).toEqual(["one.txt", "two.txt"]);
  });

  it("accepts tracked names beginning with two dots without weakening containment", async () => {
    const root = await scratch();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await mkdir(join(root, "..notes"));
    await writeFile(join(root, "..notes.txt"), "root note\n");
    await writeFile(join(root, "..notes", "nested.txt"), "nested note\n");
    await execFileAsync("git", [
      "-C",
      root,
      "add",
      "--",
      "..notes.txt",
      "..notes/nested.txt",
    ]);

    expect((await searchProjectFiles(root)).map((item) => item.path)).toEqual([
      "..notes.txt",
      "..notes/nested.txt",
    ]);
    await expect(
      isIndexedProjectFile(root, join(root, "..notes.txt")),
    ).resolves.toBe(true);
    await expect(
      isIndexedProjectFile(root, join(root, "..", "outside.txt")),
    ).resolves.toBe(false);
  });

  it("uses real git output without shell path quoting", async () => {
    const root = await scratch();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, "line\nname.txt"), "content\n");
    await execFileAsync("git", ["-C", root, "add", "line\nname.txt"]);
    expect((await searchProjectFiles(root)).map((item) => item.path)).toEqual([
      "line\nname.txt",
    ]);
  });
});
