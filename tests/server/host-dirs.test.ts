import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listHostDirectories, listHostRoots } from "../../server/host-dirs.js";

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

  it("includes symlinks that resolve to directories and skips broken ones", async () => {
    await symlink(join(root, "alpha"), join(root, "linked"));
    await symlink(join(root, "vanished"), join(root, "broken"));
    const listing = await listHostDirectories(root);
    expect(listing.dirs.map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
      "linked",
    ]);
  });

  it("defaults to the host home directory", async () => {
    const listing = await listHostDirectories();
    expect(listing.path).toBe(await realpath(homedir()));
  });

  it("reports a filesystem root with a null parent", async () => {
    const listing = await listHostDirectories("/");
    expect(listing.path).toBe("/");
    expect(listing.parent).toBeNull();
  });

  it("rejects a missing directory", async () => {
    await expect(
      listHostDirectories(join(root, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
