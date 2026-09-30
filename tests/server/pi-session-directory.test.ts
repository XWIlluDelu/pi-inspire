import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePiSessionDirectory } from "../../server/pi-session-directory.js";
import { PreferencesStore } from "../../server/preferences.js";
import {
  createHostSessionCatalog,
  SessionCatalog,
} from "../../server/session-catalog.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";

let root: string;
let cwd: string;
let agent: string;

async function settings(directory: string, value: object) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), JSON.stringify(value));
}

async function session(directory: string, id: string, project = cwd) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.jsonl`),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      cwd: project,
      timestamp: "2026-01-01T00:00:00Z",
    })}\n`,
  );
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
      expect(resolvePiSessionDirectory(cwd)).toBeUndefined();
      await settings(agent, { sessionDir: "global" });
      expect(resolvePiSessionDirectory(cwd)).toBe(join(cwd, "global"));
      await settings(join(cwd, ".pi"), { sessionDir: "local" });
      expect(resolvePiSessionDirectory(cwd)).toBe(join(cwd, "local"));
      await settings(join(cwd, ".pi"), { sessionDir: "" });
      expect(resolvePiSessionDirectory(cwd)).toBeUndefined();
    },
  );

  it("gives a nonempty env precedence without trimming and anchors it to each worker cwd", async () => {
    await settings(agent, { sessionDir: "global" });
    await settings(join(cwd, ".pi"), { sessionDir: "local" });
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", " env sessions ");
    expect(resolvePiSessionDirectory(cwd)).toBe(join(cwd, " env sessions "));
    expect(resolvePiSessionDirectory(root)).toBe(join(root, " env sessions "));
  });

  it("uses Pi normalization for absolute paths, tilde and file URLs", async () => {
    const directory = join(root, "sessions");
    for (const value of [
      directory,
      `~/${relative(homedir(), directory)}`,
      pathToFileURL(directory).href,
    ]) {
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", value);
      expect(resolvePiSessionDirectory(cwd)).toBe(directory);
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      await settings(agent, { sessionDir: value });
      expect(resolvePiSessionDirectory(cwd)).toBe(directory);
    }
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "~");
    expect(resolvePiSessionDirectory(cwd)).toBe(homedir());
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "~someone/sessions");
    expect(resolvePiSessionDirectory(cwd)).toBe(join(cwd, "~someone/sessions"));
  });
});

describe("catalog storage discovery", () => {
  it("deduplicates a custom root overlapping default storage without hiding distinct duplicate ids", async () => {
    const nested = join(agent, "sessions", "--project--");
    await session(nested, "shared");
    expect(
      await new SessionMetadataIndex().list([undefined, nested]),
    ).toHaveLength(1);
    await settings(join(cwd, ".pi"), { sessionDir: nested });
    const other = join(root, "other");
    await settings(join(other, ".pi"), { sessionDir: "custom" });
    await session(join(other, "custom"), "shared", other);
    const catalog = new SessionCatalog(cwd, undefined, async () => [other]);
    expect((await catalog.list()).sessions).toEqual([]);
    await expect(catalog.get("shared")).rejects.toMatchObject({ status: 409 });
  });

  it("discovers only the selected flat env directory, including after reconstruction", async () => {
    const selected = join(root, "selected");
    const overridden = join(root, "overridden");
    await settings(agent, { sessionDir: overridden });
    await session(overridden, "settings-session");
    await session(join(agent, "sessions", "--default--"), "default-session");
    await session(selected, "selected-session");
    await session(join(selected, "nested"), "not-flat");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", selected);
    for (let restart = 0; restart < 2; restart++) {
      const catalog = new SessionCatalog(cwd);
      expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
        "selected-session",
      ]);
      expect(await catalog.get("selected-session")).toMatchObject({
        path: join(selected, "selected-session.jsonl"),
        cwd,
      });
    }
  });

  it("does not search overridden storage when the env directory is absent", async () => {
    await settings(agent, { sessionDir: "local" });
    await session(join(cwd, "local"), "overridden");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "absent"));
    expect((await new SessionCatalog(cwd).list()).sessions).toEqual([]);
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
