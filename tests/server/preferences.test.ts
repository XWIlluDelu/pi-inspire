import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("recovers an aged lock whose owning process no longer exists", async () => {
    const { path, store } = await fixture();
    let deadPid = 999_999;
    while (true) {
      try {
        process.kill(deadPid, 0);
        deadPid += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        deadPid += 1;
      }
    }
    const lock = `${path}.lock`;
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    await expect(store.patch({ theme: "dark" })).resolves.toMatchObject({
      theme: "dark",
    });
  });

  it("installs a complete owner record as the lock authority", async () => {
    const { path, store } = await fixture();
    const lock = `${path}.lock`;
    const mutable = store as unknown as {
      persist: (
        preferences: typeof defaultPreferences,
        assertOwned: () => Promise<void>,
      ) => Promise<void>;
    };
    const persist = mutable.persist.bind(store);
    mutable.persist = async (preferences, assertOwned) => {
      const owner = JSON.parse(await readFile(lock, "utf8")) as {
        pid: number;
        token: string;
      };
      expect(owner).toMatchObject({ pid: process.pid });
      expect(owner.token).toEqual(expect.any(String));
      await assertOwned();
      await persist(preferences, assertOwned);
    };

    await expect(store.patch({ theme: "dark" })).resolves.toMatchObject({
      theme: "dark",
    });
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed without releasing a replacement write lock", async () => {
    const { path, store } = await fixture();
    const lock = `${path}.lock`;
    const replacementToken = "replacement-owner";
    const mutable = store as unknown as {
      persist: (
        preferences: typeof defaultPreferences,
        assertOwned: () => Promise<void>,
      ) => Promise<void>;
    };
    const persist = mutable.persist.bind(store);
    mutable.persist = async (preferences, assertOwned) => {
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock, { mode: 0o700 });
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          token: replacementToken,
          acquiredAt: Date.now(),
        }),
      );
      await persist(preferences, assertOwned);
    };

    await expect(store.patch({ theme: "dark" })).rejects.toMatchObject({
      status: 503,
    });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(lock, "owner.json"), "utf8")).resolves.toContain(
      replacementToken,
    );
  });
});
