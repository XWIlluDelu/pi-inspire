import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../../server/file-lock.mjs";
import { PreferencesStore } from "../../server/preferences.js";
import { defaultPreferences } from "../../shared/contracts.js";

const roots: string[] = [];

async function fixture(): Promise<{ path: string; store: PreferencesStore }> {
  const root = await mkdtemp(join(tmpdir(), "inspire-preferences-"));
  roots.push(root);
  const path = join(root, "preferences.json");
  return { path, store: new PreferencesStore(path) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PreferencesStore validation", () => {
  it("loads valid fields in memory but refuses to overwrite one invalid field", async () => {
    const { path, store } = await fixture();
    const raw = JSON.stringify({
      theme: "dark",
      launch: "continue",
      toolVisibility: "impossible",
      pinnedSessionIds: ["session-a"],
    });
    await writeFile(path, raw);

    const inspected = await store.inspect();
    expect(inspected.preferences).toMatchObject({
      theme: "dark",
      launch: "continue",
      toolVisibility: "dynamic",
      pinnedSessionIds: ["session-a"],
    });
    expect(inspected.warning).toMatch(/toolVisibility.*left unchanged/);
    await expect(store.patch({ projectDisplay: "path" })).rejects.toMatchObject(
      { status: 409 },
    );
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("reports malformed JSON repeatedly and leaves its bytes untouched", async () => {
    const { path, store } = await fixture();
    const raw = "{not-json";
    await writeFile(path, raw);

    const inspected = await store.inspect();
    expect(inspected.preferences).toEqual(defaultPreferences);
    expect(inspected.warning).toMatch(/not valid JSON.*left unchanged/);
    await expect(store.patch({ theme: "dark" })).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(path, "utf8")).toBe(raw);

    const second = await store.inspect();
    expect(second.warning).toMatch(/not valid JSON.*left unchanged/);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("treats missing legacy fields as migration defaults, not corruption", async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({ theme: "light", launch: "welcome" }),
    );

    const inspected = await store.inspect();
    expect(inspected.warning).toBeUndefined();
    expect(inspected.preferences).toMatchObject({
      theme: "light",
      launch: "welcome",
      thinkingVisibility: "dynamic",
      toolVisibility: "dynamic",
      activityFoldVisibility: "dynamic",
    });
  });

  it("serializes field patches across independent Host store instances", async () => {
    const { path } = await fixture();
    const first = new PreferencesStore(path);
    const second = new PreferencesStore(path);

    await Promise.all([
      first.patch({ theme: "dark" }),
      second.patch({ readingWidth: "wide" }),
    ]);

    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toMatchObject({ theme: "dark", readingWidth: "wide" });
    expect(await first.read()).toMatchObject({
      theme: "dark",
      readingWidth: "wide",
    });
  });

  it("continues after a dead process releases its lock", async () => {
    const { path, store } = await fixture();
    const lock = `${path}.flock`;
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "server", "file-lock.mjs"),
    ).href;
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireFileLock } from ${JSON.stringify(moduleUrl)};
         await acquireFileLock(${JSON.stringify(lock)}, { waitMs: 500 });
         process.stdout.write("ready\\n");
         setInterval(() => undefined, 1_000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let stopped = false;
    try {
      await once(holder.stdout!, "data");
      const patching = store.patch({ theme: "dark" });
      let settled = false;
      void patching.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await delay(50);
      expect(settled).toBe(false);

      holder.kill("SIGKILL");
      await once(holder, "close");
      stopped = true;
      await expect(patching).resolves.toMatchObject({ theme: "dark" });
    } finally {
      if (!stopped && holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
        await once(holder, "close");
      }
    }
  });

  it("holds the lock through the preferences rename", async () => {
    const { path, store } = await fixture();
    const lock = `${path}.flock`;
    const mutable = store as unknown as {
      persist: (
        preferences: typeof defaultPreferences,
        assertOwned: () => Promise<void>,
      ) => Promise<void>;
    };
    const persist = mutable.persist.bind(store);
    mutable.persist = async (preferences, assertOwned) => {
      await expect(
        acquireFileLock(lock, { waitMs: 50, retryMs: 10 }),
      ).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
      await assertOwned();
      await persist(preferences, assertOwned);
    };

    await expect(store.patch({ theme: "dark" })).resolves.toMatchObject({
      theme: "dark",
    });
    const lease = await acquireFileLock(lock, { waitMs: 100 });
    await lease.release();
  });

  it("fails closed when the lock path is replaced", async () => {
    const { path, store } = await fixture();
    const lock = `${path}.flock`;
    const replacement = "replacement lock inode\n";
    const mutable = store as unknown as {
      persist: (
        preferences: typeof defaultPreferences,
        assertOwned: () => Promise<void>,
      ) => Promise<void>;
    };
    const persist = mutable.persist.bind(store);
    mutable.persist = async (preferences, assertOwned) => {
      await rename(lock, `${lock}.displaced`);
      await writeFile(lock, replacement, { mode: 0o600, flag: "wx" });
      await persist(preferences, assertOwned);
    };

    await expect(store.patch({ theme: "dark" })).rejects.toMatchObject({
      status: 503,
    });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
  });
});
