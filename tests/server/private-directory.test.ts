import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "../../server/private-directory.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), "private-directory-"));
  roots.push(path);
  return path;
}

describe.runIf(process.platform !== "win32")("ensurePrivateDirectory", () => {
  it("creates a private directory", async () => {
    const path = join(await root(), "a", "b");
    await ensurePrivateDirectory(path, "test directory");
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  });

  it("refuses a directory open to others without changing it, or repairs it on request", async () => {
    const path = join(await root(), "shared");
    await mkdir(path);
    await chmod(path, 0o755);
    await expect(
      ensurePrivateDirectory(path, "test directory"),
    ).rejects.toThrow("must not be accessible by other users");
    expect((await lstat(path)).mode & 0o777).toBe(0o755);
    await ensurePrivateDirectory(path, "test directory", { loose: "repair" });
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  });

  it("refuses a symbolic link and, without create, a missing directory", async () => {
    const base = await root();
    await mkdir(join(base, "real"), { mode: 0o700 });
    await symlink(join(base, "real"), join(base, "link"));
    await expect(
      ensurePrivateDirectory(join(base, "link"), "test directory"),
    ).rejects.toThrow("not a private directory");
    await expect(
      ensurePrivateDirectory(join(base, "missing"), "test directory", {
        create: false,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
