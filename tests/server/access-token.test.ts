import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent host access token", () => {
  it("creates one private token and reuses it across host starts", async () => {
    const path = await temporaryPath();
    const first = await resolveAccessToken(undefined, path);
    const second = await resolveAccessToken(undefined, path);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("keeps an explicit environment token outside persistent storage", async () => {
    const path = await temporaryPath();
    await expect(resolveAccessToken("explicit-test-token", path)).resolves.toBe("explicit-test-token");
    await expect(resolveAccessToken("", path)).rejects.toThrow("between 1 and 256 characters");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a token file exposed to other local users", async () => {
    const path = await temporaryPath();
    await resolveAccessToken(undefined, path);
    await chmod(path, 0o644);
    await expect(resolveAccessToken(undefined, path)).rejects.toThrow("must not be accessible by other users");
  });
});
