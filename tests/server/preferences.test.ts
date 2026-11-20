import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PreferencesStore } from "../../server/preferences.js";
import { editPrivateStateJson } from "../../server/private-state-file.js";
import { defaultPreferences } from "../../shared/contracts.js";

let root: string;
let path: string;
let store: PreferencesStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-preferences-"));
  path = join(root, "preferences.json");
  store = new PreferencesStore(path);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const read = () => readFile(path, "utf8");
const write = (value: object) => writeFile(path, JSON.stringify(value));

it("repairs only addressed fields while keeping older settings and their unknown data", async () => {
  const saved = {
    theme: "dark",
    launch: "continue",
    palette: "teal",
    toolVisibility: "impossible",
    sessionActionOrder: ["terminal"],
    futurePreference: { retained: true },
    pinnedSessionIds: ["session-a"],
  };
  await write(saved);
  const before = await store.inspect();
  expect(before.warning).toMatch(
    /palette.*toolVisibility.*sessionActionOrder/u,
  );
  expect(before.preferences).toEqual({
    ...defaultPreferences,
    theme: "dark",
    launch: "continue",
    pinnedSessionIds: ["session-a"],
  });

  const patch = store.patch({ titlebarNeedles: true, readingWidth: "wide" });
  const remove = store.removeDeletedSessions(["session-a"]);
  const [changed, removed, observed] = await Promise.all([
    patch,
    remove,
    store.inspect(),
  ]);
  expect(changed.revision).toBeGreaterThan(before.revision);
  expect(removed.revision).toBeGreaterThan(changed.revision);
  expect(observed.revision).toBeGreaterThan(removed.revision);
  expect(changed.preferences).toMatchObject({
    pinnedSessionIds: ["session-a"],
    readingWidth: "wide",
  });
  const next = {
    ...saved,
    titlebarNeedles: true,
    readingWidth: "wide",
    pinnedSessionIds: [],
    hiddenSessionIds: [],
  };
  expect(JSON.parse(await read())).toEqual(next);
  expect(observed.preferences).toEqual(removed.preferences);

  const identity = { provider: "fixture", id: "model" };
  const repaired = await store.patch({
    palette: "wisteria",
    toolVisibility: "compact",
    herdrEnabled: true,
    sessionActionOrder: ["export", "rename", "clone", "switch-branch"],
    recentModelIds: [{ ...identity, name: "Display name", reasoning: true }],
  });
  const reopened = await new PreferencesStore(path).inspect();
  expect(reopened.warning).toBeUndefined();
  expect(reopened.preferences).toEqual(repaired.preferences);
  expect(JSON.parse(await read())).toEqual({
    ...next,
    palette: "wisteria",
    toolVisibility: "compact",
    herdrEnabled: true,
    sessionActionOrder: [
      "export",
      "rename",
      "clone",
      "switch-branch",
      "copy-id",
      "tool-loadout",
    ],
    recentModelIds: [identity],
  });

  const original = await read();
  for (const invalid of [
    { palette: "teal" },
    { sessionActionOrder: ["rename", "rename"] },
    { sessionActionOrder: ["unknown"] },
    { futurePreference: false },
    { recentModelIds: [{ ...identity, id: "" }] },
    { herdrEnabled: "yes" },
  ])
    await expect(store.patch(invalid)).rejects.toThrow();
  expect(await read()).toBe(original);
});

it.each([
  ["{not-json", /not valid JSON.*left unchanged/],
  ["[]", /invalid root.*left unchanged/],
] as const)(
  "blocks writes and consistently reports an unreadable preference file",
  async (raw, warning) => {
    await writeFile(path, raw);
    const before = await store.inspect();
    expect(before.preferences).toEqual(defaultPreferences);
    expect(before.warning).toMatch(warning);
    await expect(store.patch({ theme: "dark" })).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.inspect()).warning).toBe(before.warning);
    expect(await read()).toBe(raw);
  },
);

it("merges independent Host writes and keeps session cleanup available with a failed project registry", async () => {
  const project = join(dirname(path), "project");
  await write({ pinnedProjectCwds: [project], pinnedSessionIds: ["old"] });
  const invalid = "{not-json";
  await writeFile(store.projectDirectories.path, invalid);
  const otherHost = new PreferencesStore(path);
  await Promise.all([
    store.patch({ theme: "dark" }),
    otherHost.patch({ readingWidth: "wide" }),
  ]);
  await store.removeDeletedSessions(["old"]);
  await expect(store.patch({ pinnedProjectCwds: [] })).rejects.toThrow();
  const expected = {
    theme: "dark",
    readingWidth: "wide",
    pinnedSessionIds: [],
    pinnedProjectCwds: [project],
  };
  expect(JSON.parse(await read())).toMatchObject(expected);
  expect(await otherHost.read()).toMatchObject(expected);
  expect(await readFile(store.projectDirectories.path, "utf8")).toBe(invalid);
});

it.skipIf(process.platform !== "linux")(
  "fails closed when the kernel lock path is replaced",
  async () => {
    await store.patch({ theme: "light" });
    const previous = await read();
    const lock = `${path}.flock`;
    const replacement = "replacement lock inode\n";
    await expect(
      editPrivateStateJson(path, "saved preferences", async (publish) => {
        await rename(lock, `${lock}.displaced`);
        await writeFile(lock, replacement, { mode: 0o600, flag: "wx" });
        await publish({ theme: "dark" });
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await read()).toBe(previous);
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
  },
);
