import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";

const temporaryDirectories: string[] = [];

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inspire-access-token-"));
  temporaryDirectories.push(directory);
  return join(directory, "private", "access.token");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("persistent host access token", () => {
  it("creates one private token and reuses it across host starts", async () => {
    const path = await temporaryPath();
    const first = await resolveAccessToken(undefined, path);
    const second = await resolveAccessToken(undefined, path);

    expect(first).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(second).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  it("rotates prior generated token lengths once and then reuses the replacement", async () => {
    for (const length of [43, 128]) {
      const path = await temporaryPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const legacy = "a".repeat(length);
      await writeFile(path, `${legacy}\n`, { mode: 0o600 });

      const rotated = await resolveAccessToken(undefined, path);
      expect(rotated).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(rotated).not.toBe(legacy);
      expect((await readFile(path, "utf8")).trim()).toBe(rotated);
      await expect(resolveAccessToken(undefined, path)).resolves.toBe(rotated);
    }
  });

  it("keeps an explicit environment token outside persistent storage", async () => {
    const path = await temporaryPath();
    await expect(resolveAccessToken("explicit-test-token", path)).resolves.toBe(
      "explicit-test-token",
    );
    await expect(resolveAccessToken("", path)).rejects.toThrow(
      "between 1 and 256 characters",
    );
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "refuses a token path that redirects through a symbolic link",
    async () => {
      const path = await temporaryPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const target = join(dirname(path), "target.token");
      await writeFile(target, `${"a".repeat(64)}\n`, { mode: 0o600 });
      await symlink(target, path);

      await expect(resolveAccessToken(undefined, path)).rejects.toThrow(
        "not a regular file",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a token file exposed to other local users",
    async () => {
      const path = await temporaryPath();
      await resolveAccessToken(undefined, path);
      await chmod(path, 0o644);
      await expect(resolveAccessToken(undefined, path)).rejects.toThrow(
        "must not be accessible by other users",
      );
    },
  );
});
