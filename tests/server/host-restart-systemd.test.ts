import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemdRestartBackend } from "../../server/host-restart-systemd.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "inspire-preflight-probe-"));
  directories.push(root);
  await writeFile(join(root, "inspire.mjs"), source);
  return systemdRestartBackend(root, false);
}
describe("restart preparation subprocess", () => {
  it("reports a bounded specific failure without enabling service control", async () => {
    const backend = await fixture(
      "console.error('x'.repeat(10000)); console.error('\\x1b[31mSynthetic missing runtime module\\x1b[0m'); process.exitCode=1;",
    );
    expect(await backend.inspect()).toBe(false);
    await expect(backend.prepare()).rejects.toThrow(
      "Synthetic missing runtime module",
    );
    const error = await backend.prepare().catch((error) => error as Error);
    if (!error) throw new Error("Preparation unexpectedly passed");
    expect(error.message.length).toBeLessThan(4100);
    expect(error.message).not.toContain("\u001b");
    expect(
      await backend.request(true, () => {
        throw new Error("must not commit");
      }),
    ).toEqual({ issued: false, code: 1 });
  });
  it("waits for successful isolated preparation", async () => {
    const backend = await fixture(
      "if(process.argv[2]!=='prepare-restart'||process.env.INSPIRE_QUIET!=='1')process.exit(1); console.log('fixture preparation passed');",
    );
    await expect(backend.prepare()).resolves.toBeUndefined();
  });
});
