import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../../server/file-lock.mjs";
import { PreferencesStore } from "../../server/preferences.js";
import {
  defaultPreferences,
  SESSION_ACTION_IDS,
} from "../../shared/contracts.js";

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
  it.each(["details", "divider"])(
    "retires saved assistant turn %s without locking preferences",
    async (value) => {
      const { path, store } = await fixture();
      const raw = JSON.stringify({
        assistantRoundDisplay: value,
        thinkingVisibility: "expanded",
      });
      await writeFile(path, raw);
      const inspection = await store.inspect();
      expect(inspection.warning).toBeUndefined();
      expect(inspection.preferences.thinkingVisibility).toBe("expanded");
      expect(inspection.preferences).not.toHaveProperty(
        "assistantRoundDisplay",
      );
      expect(await readFile(path, "utf8")).toBe(raw);
      await store.patch({ toolVisibility: "compact" });
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved).not.toHaveProperty("assistantRoundDisplay");
      expect(saved).toMatchObject({
        thinkingVisibility: "expanded",
        toolVisibility: "compact",
      });
    },
  );
  it.each([
    ["amber", "chimonanthus"],
    ["teal", "hydrangea"],
  ])(
    "migrates saved %s to %s without invalidating other settings",
    async (legacy, palette) => {
      const { path, store } = await fixture();
      const raw = JSON.stringify({
        palette: legacy,
        theme: "dark",
        pinnedSessionIds: ["kept"],
      });
      await writeFile(path, raw);
      const inspected = await store.inspect();
      expect(inspected.warning).toBeUndefined();
      expect(inspected.preferences).toMatchObject({
        palette,
        theme: "dark",
        pinnedSessionIds: ["kept"],
      });
      // Observation is read-only; the next ordinary write saves canonical IDs.
      expect(await readFile(path, "utf8")).toBe(raw);
      await store.patch({ readingWidth: "wide" });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        palette,
        theme: "dark",
        readingWidth: "wide",
        pinnedSessionIds: ["kept"],
      });
      expect(
        (await new PreferencesStore(path).inspect()).warning,
      ).toBeUndefined();
    },
  );

  it.each([
    "wisteria",
    "hydrangea",
    "lycoris",
    "chimonanthus",
    "classic-jade",
    "classic-amber",
    "mono",
  ])("persists the %s palette independently of luminosity", async (palette) => {
    const { path, store } = await fixture();
    await store.patch({ theme: "system" });
    await store.patch({ palette });
    expect(await new PreferencesStore(path).read()).toMatchObject({
      palette,
      theme: "system",
    });
  });

  it("accepts legacy client patches but never writes legacy IDs", async () => {
    const { path, store } = await fixture();
    expect(await store.patch({ palette: "teal" })).toMatchObject({
      palette: "hydrangea",
    });
    expect(JSON.parse(await readFile(path, "utf8")).palette).toBe("hydrangea");
    await expect(store.patch({ palette: "jade" })).rejects.toBeDefined();
    expect((await store.read()).palette).toBe("hydrangea");
  });

  it("defaults titlebar needles off and persists the choice across reloads", async () => {
    const { path, store } = await fixture();
    await writeFile(path, JSON.stringify({ theme: "dark" }));
    expect((await store.read()).titlebarNeedles).toBe(false);
    await store.patch({ titlebarNeedles: true });
    expect(await new PreferencesStore(path).read()).toMatchObject({
      titlebarNeedles: true,
      theme: "dark",
    });
  });

  it("persists session action order and appends actions absent from an older saved order", async () => {
    const { path, store } = await fixture();
    expect((await store.read()).sessionActionOrder).toEqual(SESSION_ACTION_IDS);
    await store.patch({
      theme: "dark",
      sessionActionOrder: ["export", "rename", "clone", "terminal"],
    });
    const order = ["export", "rename", "clone", "terminal", "copy-id"];
    expect(await new PreferencesStore(path).read()).toMatchObject({
      theme: "dark",
      sessionActionOrder: order,
    });
    await expect(
      store.patch({ sessionActionOrder: ["rename", "rename"] }),
    ).rejects.toBeDefined();
    await expect(
      store.patch({ sessionActionOrder: ["unknown"] }),
    ).rejects.toBeDefined();
    expect((await store.read()).sessionActionOrder).toEqual(order);
  });

  it("preserves invalid and unknown fields while saving unrelated settings and allows field repair", async () => {
    const { path, store } = await fixture();
    const raw = JSON.stringify({
      theme: "dark",
      launch: "continue",
      toolVisibility: "impossible",
      futurePreference: { retained: true },
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
    await expect(
      store.patch({ projectDisplay: "path" }),
    ).resolves.toMatchObject({
      projectDisplay: "path",
      toolVisibility: "dynamic",
    });
    await store.setTerminalSession("terminal-a", true);
    await store.removeSession("session-a");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      toolVisibility: "impossible",
      futurePreference: { retained: true },
      projectDisplay: "path",
      pinnedSessionIds: [],
      terminalSessionIds: ["terminal-a"],
    });
    await store.patch({ toolVisibility: "compact" });
    expect((await store.inspect()).warning).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      toolVisibility: "compact",
      futurePreference: { retained: true },
    });
    await expect(
      store.patch({ futurePreference: false }),
    ).rejects.toBeDefined();
  });

  it("stores only valid model identity from a full model selection", async () => {
    const { path, store } = await fixture();
    const identity = { provider: "fixture", id: "model" };
    await store.patch({
      recentModelIds: [
        {
          ...identity,
          name: "Display name",
          reasoning: true,
          thinkingLevelMap: { high: "high" },
        },
      ],
    });
    expect(JSON.parse(await readFile(path, "utf8")).recentModelIds).toEqual([
      identity,
    ]);
    await expect(
      store.patch({ recentModelIds: [{ ...identity, id: "" }] }),
    ).rejects.toBeDefined();
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

  it("defaults Herdr off, validates the boolean, and persists a field-scoped opt-in", async () => {
    const { path, store } = await fixture();
    expect((await store.read()).herdrEnabled).toBe(false);
    await expect(store.patch({ herdrEnabled: "yes" })).rejects.toBeDefined();
    await store.patch({ herdrEnabled: true });
    expect(JSON.parse(await readFile(path, "utf8")).herdrEnabled).toBe(true);
    await store.patch({ herdrEnabled: false });
    expect((await store.read()).herdrEnabled).toBe(false);
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
