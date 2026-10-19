import { execFile } from "node:child_process";
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
import { prepareSessionRecovery } from "../../server/session-recovery.js";

const run = promisify(execFile);
const launcher = resolve("inspire.mjs");

it("recovers a relative bundle from the caller's cwd without starting a Host or Pi", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-recovery-launcher-")),
  );
  try {
    const originalDirectory = join(root, "original sessions");
    const bundle = join(root, "restored recovery bundle");
    await mkdir(originalDirectory);
    await mkdir(bundle);
    const original = join(originalDirectory, "conversation.jsonl");
    const contents =
      JSON.stringify({ type: "session", id: "launcher-recovery", cwd: root }) +
      "\n";
    const payload = join(bundle, "conversation.jsonl");
    await writeFile(payload, contents);
    await prepareSessionRecovery(payload, original);
    const result = await run(
      process.execPath,
      [launcher, "recover-session", "restored recovery bundle"],
      {
        cwd: root,
        timeout: 15_000,
      },
    );
    expect(result.stdout).toContain("Recovered session: " + original);
    expect(result.stdout).toContain("Recovery bundle retained");
    expect(await readFile(original, "utf8")).toBe(contents);
    expect(await readFile(payload, "utf8")).toBe(contents);
    await expect(
      run(process.execPath, [launcher, "recover-session", bundle], {
        cwd: root,
        timeout: 15_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
