import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../server/preferences.js";
import { ProjectDirectoryStore } from "../../server/project-directories.js";
import { createHostSessionCatalog } from "../../server/session-catalog.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-project-directories-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("durable project discovery roots", () => {
  it("merges concurrent Host writers, deduplicates, and does not rewrite known roots", async () => {
    const path = join(root, "config", "projects.json");
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new ProjectDirectoryStore(path).remember([
          join(root, `project-${index}`),
          root,
        ]),
      ),
    );
    const store = new ProjectDirectoryStore(path);
    const expected = [
      root,
      ...Array.from({ length: 8 }, (_, index) =>
        join(root, `project-${index}`),
      ),
    ];
    expect((await store.read()).sort()).toEqual(expected.sort());
    const before = await stat(path);
    await store.remember([root, join(root, "project-0")]);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    if (process.platform !== "win32") expect(before.mode & 0o777).toBe(0o600);
  });

  it("rejects malformed knowledge rather than replacing it or silently orphaning roots", async () => {
    const store = new ProjectDirectoryStore(join(root, "projects.json"));
    for (const text of ["not json", '{"sessions":[]}', '["relative/path"]']) {
      await writeFile(store.path, text);
      await expect(store.remember([root])).rejects.toThrow();
      await expect(store.read()).rejects.toThrow();
      expect(await readFile(store.path, "utf8")).toBe(text);
    }
  });

  it("retains startup roots across startup-directory changes without scanning unknown projects", async () => {
    const preferencesPath = join(root, "preferences.json");
    const startup = join(root, "previous-startup");
    const unknown = join(root, "unknown");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "sessions");
    for (const cwd of [startup, unknown]) {
      await mkdir(join(cwd, "sessions"), { recursive: true });
      await writeFile(
        join(cwd, "sessions", "session.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: cwd, cwd, timestamp: new Date().toISOString() })}\n`,
      );
    }
    await createHostSessionCatalog(
      startup,
      new PreferencesStore(preferencesPath),
    ).refresh();
    const reconstructed = createHostSessionCatalog(
      root,
      new PreferencesStore(preferencesPath),
    );
    expect((await reconstructed.list()).sessions.map((row) => row.id)).toEqual([
      startup,
    ]);
    await rm(startup, { recursive: true });
    expect(await reconstructed.refresh(true)).toEqual([]);
    expect(
      await new PreferencesStore(preferencesPath).projectDirectories.read(),
    ).toContain(startup);
  });

  it("keeps externally stored sessions for a missing project but never searches superseded settings", async () => {
    const preferences = new PreferencesStore(join(root, "preferences.json"));
    const project = join(root, "missing-project");
    const external = join(root, "external");
    await preferences.projectDirectories.remember([project]);
    await mkdir(join(root, "agent"));
    await mkdir(external);
    await writeFile(
      join(root, "agent", "settings.json"),
      JSON.stringify({ sessionDir: external }),
    );
    const file = join(external, "session.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "external", cwd: project, timestamp: new Date().toISOString() })}\n`,
    );
    const catalog = createHostSessionCatalog(root, preferences);
    expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
      "external",
    ]);
    await writeFile(
      join(root, "agent", "settings.json"),
      JSON.stringify({ sessionDir: join(root, "new-storage") }),
    );
    expect(await catalog.refresh(true)).toEqual([]);
    await writeFile(
      join(root, "agent", "settings.json"),
      JSON.stringify({ sessionDir: external }),
    );
    expect((await catalog.refresh(true)).map((row) => row.id)).toEqual([
      "external",
    ]);
    await rm(file);
    expect(await catalog.refresh(true)).toEqual([]);
    expect(await preferences.projectDirectories.read()).toContain(project);
  });
});
