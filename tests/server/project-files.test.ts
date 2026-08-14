import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directoryEntries,
  searchProjectFiles,
} from "../../server/project-files.js";

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
});
