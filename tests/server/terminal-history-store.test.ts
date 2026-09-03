import { chmod, lstat, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHistoryStore } from "../../server/terminal-history-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inspire-terminal-history-"));
  directories.push(root);
  const directory = join(root, "history");
  return { directory, store: new TerminalHistoryStore(directory) };
}

describe("TerminalHistoryStore", () => {
  it("batches private output and clears it", async () => {
    const { directory, store } = await setup();
    store.append("terminal-1", Buffer.from("one"));
    store.append("terminal-1", Buffer.from(" two"));
    await store.flush();

    expect(String(await store.read("terminal-1"))).toBe("one two");
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o077).toBe(0);
      expect(
        (await lstat(join(directory, "terminal-1.log"))).mode & 0o077,
      ).toBe(0);
    }

    await store.clear();
    expect(await store.read("terminal-1")).toBeNull();
  });

  it("prunes output older than the configured retention", async () => {
    const { directory, store } = await setup();
    store.append("terminal-old", Buffer.from("old"));
    store.append("terminal-new", Buffer.from("new"));
    await store.flush();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await utimes(join(directory, "terminal-old.log"), old, old);

    await store.prune(5);

    expect(await store.read("terminal-old")).toBeNull();
    expect(String(await store.read("terminal-new"))).toBe("new");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a substituted history symlink",
    async () => {
      const { directory, store } = await setup();
      await store.append("warmup", Buffer.from("ok"));
      await store.flush();
      const target = join(directory, "target");
      await chmod(directory, 0o700);
      await symlink(target, join(directory, "terminal-link.log"));

      await expect(store.read("terminal-link")).rejects.toThrow(/invalid/u);
    },
  );
});
