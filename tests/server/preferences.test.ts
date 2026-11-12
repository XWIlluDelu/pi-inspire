import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("accepts only current palette identifiers in patches", async () => {
    const { path, store } = await fixture();
    await store.patch({ palette: "wisteria" });
    await expect(store.patch({ palette: "teal" })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8")).palette).toBe("wisteria");
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
    expect((await store.read()).sessionActionOrder).toEqual([
      "rename",
      "copy-id",
      "clone",
      "switch-branch",
      "export",
    ]);
    await store.patch({
      theme: "dark",
      sessionActionOrder: ["export", "rename", "clone", "switch-branch"],
    });
    const order = ["export", "rename", "clone", "switch-branch", "copy-id"];
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

  it.each([
    {
      retired: "resume-command",
      savedOrder: ["rename", "copy-id", "clone", "resume-command", "export"],
      migratedOrder: ["rename", "copy-id", "clone", "switch-branch", "export"],
    },
    {
      retired: "terminal",
      savedOrder: ["export", "terminal", "rename"],
      migratedOrder: ["export", "switch-branch", "rename", "copy-id", "clone"],
    },
  ])(
    "replaces saved $retired with Switch branch in place",
    async ({ savedOrder, migratedOrder }) => {
      const { path, store } = await fixture();
      const raw = JSON.stringify({
        sessionActionOrder: savedOrder,
      });
      await writeFile(path, raw);
      const inspected = await store.inspect();
      expect(inspected.warning).toBeUndefined();
      expect(inspected.preferences.sessionActionOrder).toEqual(migratedOrder);
      expect(await readFile(path, "utf8")).toBe(raw);

      await store.patch({ theme: "dark" });
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.sessionActionOrder).toEqual(migratedOrder);
    },
  );

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
    await store.removeSession("session-a");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      toolVisibility: "impossible",
      futurePreference: { retained: true },
      projectDisplay: "path",
      pinnedSessionIds: [],
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

  it("saves appearance and session-only cleanup independently of project discovery", async () => {
    const { path, store } = await fixture();
    const project = join(dirname(path), "project");
    await writeFile(
      path,
      JSON.stringify({
        pinnedProjectCwds: [project],
        pinnedSessionIds: ["old"],
      }),
    );
    const invalidRegistry = "{not-json";
    await writeFile(store.projectDirectories.path, invalidRegistry);

    await store.patch({ theme: "dark" });
    await store.removeSession("old");
    await expect(store.patch({ pinnedProjectCwds: [] })).rejects.toThrow();
    expect(await store.read()).toMatchObject({
      theme: "dark",
      pinnedSessionIds: [],
      pinnedProjectCwds: [project],
    });
    expect(await readFile(store.projectDirectories.path, "utf8")).toBe(
      invalidRegistry,
    );
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

  it("fails closed when the lock path is replaced", async () => {
    const { path, store } = await fixture();
    await store.patch({ theme: "light" });
    const previous = await readFile(path, "utf8");
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
    await expect(readFile(path, "utf8")).resolves.toBe(previous);
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
  });
});
