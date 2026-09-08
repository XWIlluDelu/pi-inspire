import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listHostDirectories, listHostRoots } from "../../server/host-dirs.js";
import * as hiddenAttributes from "../../server/host-hidden-dirs.js";

const execFile = promisify(execFileCallback);

describe("listHostRoots", () => {
  it("returns the single POSIX root without probing drive letters", async () => {
    const inspect = vi.fn();
    await expect(listHostRoots("linux", inspect)).resolves.toEqual({
      roots: [{ name: "/", path: "/" }],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("discovers readable Windows drive roots in drive-letter order", async () => {
    const inspect = vi.fn(async (path: string) => {
      if (path === "C:\\" || path === "D:\\")
        return { isDirectory: () => true };
      throw Object.assign(new Error("unavailable drive"), { code: "ENOENT" });
    });

    await expect(listHostRoots("win32", inspect)).resolves.toEqual({
      roots: [
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
      ],
    });
    expect(inspect).toHaveBeenCalledTimes(26);
  });
});

describe("listHostDirectories", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inspire-hostdirs-"));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "notes.txt"), "not a directory");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists visible subdirectories sorted, with host-joined paths", async () => {
    const listing = await listHostDirectories(root);
    const resolved = await realpath(root);
    expect(listing.path).toBe(resolved);
    expect(listing.parent).toBe(dirname(resolved));
    expect(listing.dirs).toEqual([
      { name: "alpha", path: join(resolved, "alpha") },
      { name: "beta", path: join(resolved, "beta") },
    ]);
  });

  it("reveals dot directories only when requested, without including files", async () => {
    await writeFile(join(root, ".hidden-file"), "not a directory");
    const resolved = await realpath(root);
    expect((await listHostDirectories(root, true)).dirs).toEqual([
      { name: ".hidden", path: join(resolved, ".hidden") },
      { name: "alpha", path: join(resolved, "alpha") },
      { name: "beta", path: join(resolved, "beta") },
    ]);
    expect(
      (await listHostDirectories(root, false)).dirs.map((entry) => entry.name),
    ).toEqual(["alpha", "beta"]);
  });

  it("can enter a hidden path directly and still filter its hidden children", async () => {
    const path = join(root, ".hidden");
    await mkdir(join(path, "visible"));
    await mkdir(join(path, ".nested"));
    const listing = await listHostDirectories(path);
    expect(listing.path).toBe(await realpath(path));
    expect(listing.dirs.map((entry) => entry.name)).toEqual(["visible"]);
    expect(
      (await listHostDirectories(path, true)).dirs.map((entry) => entry.name),
    ).toEqual([".nested", "visible"]);
  });

  it("filters native hidden names independently of dot names and bypasses inspection when showing all", async () => {
    const inspect = vi
      .spyOn(hiddenAttributes, "listNativeHiddenNames")
      .mockResolvedValue(new Set(["alpha"]));
    expect(
      (await listHostDirectories(root)).dirs.map((entry) => entry.name),
    ).toEqual(["beta"]);
    expect(inspect).toHaveBeenCalledWith(await realpath(root));
    inspect.mockClear();
    expect(
      (await listHostDirectories(root, true)).dirs.map((entry) => entry.name),
    ).toEqual([".hidden", "alpha", "beta"]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("lets explicit show-hidden browsing recover from unavailable native inspection", async () => {
    vi.spyOn(hiddenAttributes, "listNativeHiddenNames").mockRejectedValue(
      new Error("Cannot read hidden-folder attributes on the host"),
    );
    await expect(listHostDirectories(root)).rejects.toThrow(
      "Cannot read hidden-folder attributes",
    );
    await expect(listHostDirectories(root, true)).resolves.toMatchObject({
      dirs: expect.arrayContaining([
        { name: ".hidden", path: join(await realpath(root), ".hidden") },
      ]),
    });
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "honors real native hidden attributes on this host",
    async () => {
      const path = join(root, "hidden by OS & 中文 [1]");
      await mkdir(path);
      const command =
        process.platform === "win32" ? "attrib.exe" : "/bin/chflags";
      const set = process.platform === "win32" ? "+H" : "hidden";
      const clear = process.platform === "win32" ? "-H" : "nohidden";
      await execFile(command, [set, path]);
      try {
        expect(
          (await listHostDirectories(root)).dirs.map((entry) => entry.name),
        ).not.toContain("hidden by OS & 中文 [1]");
        expect(
          (await listHostDirectories(root, true)).dirs.map(
            (entry) => entry.name,
          ),
        ).toContain("hidden by OS & 中文 [1]");
        expect((await listHostDirectories(path)).path).toBe(
          await realpath(path),
        );
      } finally {
        await execFile(command, [clear, path]);
      }
    },
    30_000,
  );

  it("reveals dot-prefixed directory links without changing host path handling", async () => {
    await symlink(
      join(root, "alpha"),
      join(root, ".linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (await listHostDirectories(root)).dirs.map((entry) => entry.name),
    ).not.toContain(".linked");
    expect((await listHostDirectories(root, true)).dirs).toContainEqual({
      name: ".linked",
      path: join(await realpath(root), ".linked"),
    });
    expect((await listHostDirectories(join(root, ".linked"), true)).path).toBe(
      await realpath(join(root, "alpha")),
    );
  });

  it.runIf(process.platform !== "win32")(
    "includes symlinks that resolve to directories and skips broken ones",
    async () => {
      await symlink(join(root, "alpha"), join(root, "linked"));
      await symlink(join(root, "vanished"), join(root, "broken"));
      const listing = await listHostDirectories(root);
      expect(listing.dirs.map((entry) => entry.name)).toEqual([
        "alpha",
        "beta",
        "linked",
      ]);
    },
  );

  it("defaults to the host home directory", async () => {
    const listing = await listHostDirectories();
    expect(listing.path).toBe(await realpath(homedir()));
  });

  it("reports a filesystem root with a null parent", async () => {
    const listing = await listHostDirectories("/");
    expect(listing.path).toBe(resolve("/"));
    expect(listing.parent).toBeNull();
  });

  it("rejects a missing directory", async () => {
    await expect(
      listHostDirectories(join(root, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
