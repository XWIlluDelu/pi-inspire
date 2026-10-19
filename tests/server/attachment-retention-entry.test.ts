import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  RETENTION_MARKER,
  RETENTION_REGISTRY,
} from "../../server/attachment-retention-identity.js";
import { piInstallation } from "../../server/pi-installation.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const run = promisify(execFile);
// Several independent SDK/CLI boots plus native volume queries.
it("previews and explicitly migrates a real isolated default store across fresh processes without a Host", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-retention-entry-")),
  );
  try {
    const env = isolatedTestEnvironment(root, {
      INSPIRE_PI_COMMAND: piInstallation.cliPath,
    });
    const phase = async (name: string) =>
      JSON.parse(
        (
          await run(
            process.execPath,
            [
              "--import",
              "tsx",
              resolve("tests/fixtures/attachment-retention-process.ts"),
              name,
              root,
            ],
            { env, timeout: 30_000 },
          )
        ).stdout.trim(),
      );
    await phase("send");
    const accepted = JSON.parse(
      await readFile(join(root, "accepted.json"), "utf8"),
    );
    const directory = dirname(accepted.session),
      registry = join(dirname(accepted.path), RETENTION_REGISTRY);
    const original = await readFile(registry, "utf8");
    await writeFile(
      registry,
      JSON.stringify({ version: 2, directories: [directory], linuxMounts: {} }),
    );
    await rm(join(directory, RETENTION_MARKER));
    const entry = async (...flags: string[]) =>
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("server/attachment-retention-entry.ts"),
          "trust-session-directory",
          directory,
          ...flags,
        ],
        { env, timeout: 30_000 },
      );
    const before = await readFile(registry, "utf8"),
      names = await readdir(directory);
    expect((await entry()).stdout).toContain("No files changed");
    expect(await readdir(directory)).toEqual(names);
    expect(await readFile(registry, "utf8")).toBe(before);
    expect((await phase("read")).deferred).toContain(
      "Unverified session retention",
    );
    const confirmed = await entry("--confirm");
    expect(confirmed.stdout).toContain("Storage continuity recorded");
    expect(confirmed.stderr).toContain("complete original session and Trash");
    expect((await phase("read")).deferred).toBeUndefined();
    expect((await phase("delete")).reclaimed).toEqual([accepted.path]);
    await expect(access(accepted.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.parse(original).identities[directory].volume).toBeTruthy();
    await expect(entry("--accept-replacement")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Usage:"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
