import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHostDirectories } from "../../server/host-dirs.js";

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
    expect(listing.dirs.map((entry) => entry.name)).toEqual(["alpha", "beta", "linked"]);
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
    await expect(listHostDirectories(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
