import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../server/pi-runtime.js";
import { createPiSessionDirectoryResolver } from "../../server/pi-session-directory.js";
import { PreferencesStore } from "../../server/preferences.js";
import {
  createHostSessionCatalog,
  SessionCatalog,
} from "../../server/session-catalog.js";

let root: string;
let cwd: string;
let agent: string;

const resolveFreshDirectory = (cwd: string) =>
  createPiSessionDirectoryResolver()(cwd);

async function settings(directory: string, value: object) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), JSON.stringify(value));
}

async function session(
  directory: string,
  id: string,
  project = cwd,
  parentSession?: string,
) {
  const path = join(directory, `${id}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      cwd: project,
      parentSession,
      timestamp: "2026-01-01T00:00:00Z",
    })}\n`,
  );
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-session-directory-"));
  cwd = join(root, "project");
  agent = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agent);
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Pi session-directory selection", () => {
  it.each([undefined, ""])(
    "falls through an absent/empty env (%j) to project then global settings",
    async (environment) => {
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", environment);
      expect(await resolveFreshDirectory(cwd)).toBeUndefined();
      await settings(agent, { sessionDir: "global" });
      expect(await resolveFreshDirectory(cwd)).toBe(join(cwd, "global"));
      await settings(join(cwd, ".pi"), { sessionDir: "local" });
      expect(await resolveFreshDirectory(cwd)).toBe(join(cwd, "local"));
      await settings(join(cwd, ".pi"), { sessionDir: "" });
      expect(await resolveFreshDirectory(cwd)).toBeUndefined();
    },
  );

  it.each(["global", "project"])(
    "yields during a %s settings lock and reads the writer’s fresh value",
    async (scope) => {
      const directory = scope === "global" ? agent : join(cwd, ".pi");
      await settings(directory, { sessionDir: "before" });
      const path = join(directory, "settings.json");
      const release = await lockfile.lock(path, { realpath: false });
      let released = false;
      let completed = false;
      const pending = resolveFreshDirectory(cwd).finally(() => {
        completed = true;
      });
      try {
        // A synchronous SDK read would exhaust its lock retries before this
        // Host event-loop callback could release the writer.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(completed).toBe(false);
        await settings(directory, { sessionDir: "after" });
        await release();
        released = true;
        await expect(pending).resolves.toBe(join(cwd, "after"));
        await settings(directory, { sessionDir: "next-scan" });
        expect(await resolveFreshDirectory(cwd)).toBe(join(cwd, "next-scan"));
      } finally {
        if (!released) await release();
        await pending.catch(() => undefined);
      }
    },
  );

  it("gives a nonempty env precedence without trimming and anchors it to each worker cwd", async () => {
    await settings(agent, { sessionDir: "global" });
    await settings(join(cwd, ".pi"), { sessionDir: "local" });
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", " env sessions ");
    const resolveDirectory = createPiSessionDirectoryResolver();
    expect(await resolveDirectory(cwd)).toBe(join(cwd, " env sessions "));
    expect(await resolveDirectory(root)).toBe(join(root, " env sessions "));
  });

  it("uses Pi normalization for absolute paths, tilde and file URLs", async () => {
    const directory = join(root, "sessions");
    for (const value of [
      directory,
      `~/${relative(homedir(), directory)}`,
      pathToFileURL(directory).href,
    ]) {
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", value);
      expect(await resolveFreshDirectory(cwd)).toBe(directory);
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      await settings(agent, { sessionDir: value });
      expect(await resolveFreshDirectory(cwd)).toBe(directory);
    }
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "~");
    expect(await resolveFreshDirectory(cwd)).toBe(homedir());
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "~someone/sessions");
    expect(await resolveFreshDirectory(cwd)).toBe(
      join(cwd, "~someone/sessions"),
    );
  });

  it("uses one global settings observation per scan and preserves project overrides", async () => {
    const local = join(root, "local");
    const other = join(root, "other");
    await settings(join(local, ".pi"), { sessionDir: "project" });
    await settings(agent, { sessionDir: "before" });
    const resolveDirectory = createPiSessionDirectoryResolver();
    expect(await resolveDirectory(cwd)).toBe(join(cwd, "before"));
    await settings(agent, { sessionDir: "after" });
    expect(await resolveDirectory(local)).toBe(join(local, "project"));
    expect(await resolveDirectory(other)).toBe(join(other, "before"));
    expect(await resolveFreshDirectory(other)).toBe(join(other, "after"));
  });
});

describe("catalog storage discovery", () => {
  it("keeps Pi’s settings-layer selection on read failure and refreshes repaired settings", async () => {
    await session(join(agent, "sessions", "--default--"), "default");
    const configured = join(root, "configured");
    await session(configured, "configured");
    await settings(agent, { sessionDir: configured });
    const catalog = new SessionCatalog(cwd);
    expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
      "configured",
    ]);
    const release = await lockfile.lock(join(agent, "settings.json"), {
      realpath: false,
    });
    try {
      expect(SettingsManager.create(cwd).getSessionDir()).toBeUndefined();
      expect((await catalog.refresh(true)).map((row) => row.id)).toEqual([
        "default",
      ]);
    } finally {
      await release();
    }
    await writeFile(join(agent, "settings.json"), "{");
    await settings(join(cwd, ".pi"), { sessionDir: configured });
    expect(SettingsManager.create(cwd).getSessionDir()).toBe(configured);
    expect((await catalog.refresh(true)).map((row) => row.id)).toEqual([
      "configured",
    ]);
    await settings(agent, { sessionDir: configured });
    await writeFile(join(cwd, ".pi", "settings.json"), "{");
    expect(SettingsManager.create(cwd).getSessionDir()).toBe(configured);
    expect((await catalog.refresh(true)).map((row) => row.id)).toEqual([
      "configured",
    ]);
  });

  it("deduplicates overlapping storage but withholds ambiguous sessions and their fork links until repaired", async () => {
    const nested = join(agent, "sessions", "--project--");
    const parent = await session(nested, "shared");
    await session(nested, "fork", cwd, parent);
    const overlap = join(root, "overlap");
    await settings(join(overlap, ".pi"), { sessionDir: nested });
    const other = join(root, "other");
    await settings(join(other, ".pi"), { sessionDir: "custom" });
    const catalog = new SessionCatalog(cwd, undefined, async () => [
      overlap,
      other,
    ]);
    expect((await catalog.list()).sessions).toMatchObject([
      { id: "fork", parentSessionId: "shared" },
      { id: "shared" },
    ]);

    const duplicate = await session(join(other, "custom"), "shared", other);
    await catalog.refresh(true);
    const remaining = (await catalog.list()).sessions;
    expect(remaining.map(({ id }) => id)).toEqual(["fork"]);
    expect(remaining[0]).not.toHaveProperty("parentSessionId");
    await expect(catalog.get("shared")).rejects.toMatchObject({ status: 409 });
    await expect(catalog.listByIds(["shared"])).rejects.toMatchObject({
      status: 409,
    });

    await rm(duplicate);
    catalog.invalidate();
    await expect(catalog.get("shared")).resolves.toMatchObject({
      path: parent,
    });
  });

  it("reads only the selected flat env directory and never falls back to overridden storage", async () => {
    const selected = join(root, "selected");
    const overridden = join(root, "overridden");
    await settings(agent, { sessionDir: overridden });
    await session(overridden, "settings-session");
    await session(join(agent, "sessions", "--default--"), "default-session");
    const path = await session(selected, "selected-session");
    await session(join(selected, "nested"), "not-flat");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", selected);
    const catalog = new SessionCatalog(cwd);
    expect((await catalog.list()).sessions.map(({ id }) => id)).toEqual([
      "selected-session",
    ]);
    expect(await catalog.get("selected-session")).toMatchObject({ path, cwd });

    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "absent"));
    expect(await catalog.refresh(true)).toEqual([]);
  });

  it("reconstructs project-local storage from existing saved pinned and hidden folders", async () => {
    const pinned = join(root, "pinned");
    const hidden = join(root, "hidden");
    const preferencesPath = join(root, "preferences.json");
    // Pre-index preferences, as written by an older Host.
    await writeFile(
      preferencesPath,
      JSON.stringify({
        pinnedProjectCwds: [pinned],
        hiddenProjectCwds: [hidden],
      }),
    );
    await settings(join(pinned, ".pi"), { sessionDir: "private-sessions" });
    await settings(join(hidden, ".pi"), { sessionDir: "hidden-sessions" });
    await session(join(pinned, "private-sessions"), "pinned", pinned);
    await session(join(hidden, "hidden-sessions"), "hidden", hidden);
    await session(join(agent, "sessions", "--ordinary--"), "ordinary");
    for (let restart = 0; restart < 2; restart++) {
      const preferences = new PreferencesStore(preferencesPath);
      // Even Unpin/Unhide as the first action, before any scan, must retain
      // the legacy roots independently from their navigation preferences.
      await preferences.patch({ pinnedProjectCwds: [], hiddenProjectCwds: [] });
      const catalog = createHostSessionCatalog(cwd, preferences);
      expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
        "hidden",
        "ordinary",
        "pinned",
      ]);
      expect((await catalog.listByCwds([pinned])).map((row) => row.id)).toEqual(
        ["pinned"],
      );
      expect(await catalog.get("hidden")).toMatchObject({ cwd: hidden });
    }
  });

  it("resolves a relative env separately for saved projects and deduplicates shared roots", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await session(join(cwd, "sessions"), "startup");
    await session(join(other, "sessions"), "other", other);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "sessions");
    const catalog = new SessionCatalog(cwd, undefined, async () => [
      other,
      cwd,
      other,
    ]);
    expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
      "other",
      "startup",
    ]);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(other, "sessions"));
    await catalog.refresh(true);
    expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
      "other",
    ]);
  });
});
