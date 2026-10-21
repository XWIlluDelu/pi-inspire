import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspireStateDirectory } from "../../server/platform-paths.mjs";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const execFile = promisify(execFileCallback);
// Preview and confirmation each launch an independent CLI and native adapter.
it("the source launcher previews then explicitly trusts a relative legacy storage root without starting a Host", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retention-cli-")));
  const env = isolatedTestEnvironment(root, {
    INSPIRE_ENVIRONMENT: "inherit",
    INSPIRE_OPEN: "0",
  });
  const parent = join(
    inspireStateDirectory({ environment: env, home: root }),
    "attachments",
  );
  const uploads = join(parent, "98765431-1234-fixture");
  const sessionDir = join(root, "session directory");
  await Promise.all([mkdir(uploads, { recursive: true }), mkdir(sessionDir)]);
  const path = join(uploads, ".session-directories.json");
  const original = JSON.stringify({
    version: 2,
    directories: [sessionDir],
    linuxMounts: {},
  });
  await writeFile(path, original);
  const invoke = (...args: string[]) =>
    execFile(
      process.execPath,
      [
        resolve("inspire.mjs"),
        "uploads",
        "trust-session-directory",
        "session directory",
        ...args,
      ],
      { cwd: root, env, timeout: 60_000 },
    );
  try {
    expect((await invoke()).stdout).toContain("No files changed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await invoke("--confirm")).stdout).toContain(
      "Storage continuity recorded",
    );
    const registry = JSON.parse(await readFile(path, "utf8"));
    expect(registry.version).toBe(3);
    expect(
      await readFile(
        join(sessionDir, ".inspire-upload-retention-root.json"),
        "utf8",
      ),
    ).toContain("id");
    await expect(readFile(join(root, "instance.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
