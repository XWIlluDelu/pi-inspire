import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultPreferences, type InspirePreferences } from "../shared/contracts.js";

// Field validators stay default-free here: `.partial()` keeps `.default()`,
// so a patch schema derived from defaulted fields would fill absent keys and
// clobber stored values on every patch.
const preferenceFields = {
  theme: z.enum(["system", "light", "dark"]),
  launch: z.enum(["welcome", "continue"]),
  thinkingVisibility: z.enum(["hidden", "collapsed", "expanded"]),
  toolVisibility: z.enum(["hidden", "collapsed", "expanded"]),
  projectDisplay: z.enum(["folder", "path"]),
  completionAttention: z.enum(["off", "title", "desktop"]),
  recentModelIds: z.array(z.object({
    provider: z.string().min(1).max(120),
    id: z.string().min(1).max(240),
  }).strict()).max(8),
  pinnedSessionIds: z.array(z.string().min(1).max(128)).max(100),
  pinnedProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenSessionIds: z.array(z.string().min(1).max(128)).max(500),
  navCollapsedGroups: z.array(z.string().min(1).max(4_096)).max(500),
};

// Full reads keep defaults so stored files predating the navigation fields
// still parse.
const preferencesSchema = z.object({
  ...preferenceFields,
  projectDisplay: preferenceFields.projectDisplay.default("folder"),
  completionAttention: preferenceFields.completionAttention.default("off"),
  recentModelIds: preferenceFields.recentModelIds.default([]),
  pinnedSessionIds: preferenceFields.pinnedSessionIds.default([]),
  pinnedProjectCwds: preferenceFields.pinnedProjectCwds.default([]),
  hiddenSessionIds: preferenceFields.hiddenSessionIds.default([]),
  navCollapsedGroups: preferenceFields.navCollapsedGroups.default([]),
});

// Writes are field-scoped patches merged over the stored file, never full
// snapshots, so concurrent writers can only contend on the fields they
// actually changed. `.strict()` keeps unknown keys out of the stored file.
const preferencesPatchSchema = z.object(preferenceFields).partial().strict();

export class PreferencesStore {
  readonly path: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(path = join(homedir(), ".config", "inspire", "preferences.json")) {
    this.path = path;
  }

  private async readDisk(): Promise<InspirePreferences> {
    try {
      const parsed = preferencesSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      return parsed.success ? parsed.data : defaultPreferences;
    } catch {
      return defaultPreferences;
    }
  }

  async read(): Promise<InspirePreferences> {
    await this.writes;
    return this.readDisk();
  }

  private async persist(preferences: InspirePreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async patch(value: unknown): Promise<InspirePreferences> {
    const patch = preferencesPatchSchema.parse(value);
    return this.enqueue(async () => {
      const preferences = preferencesSchema.parse({ ...(await this.readDisk()), ...patch });
      await this.persist(preferences);
      return preferences;
    });
  }

  /** Remove navigation identities after their authoritative session file has
   * gone. The read/transform/write stays in the same serialized preference
   * operation, so a concurrent pin or hide patch cannot be overwritten. */
  async removeSession(sessionId: string): Promise<InspirePreferences> {
    return this.enqueue(async () => {
      const current = await this.readDisk();
      const preferences = preferencesSchema.parse({
        ...current,
        pinnedSessionIds: current.pinnedSessionIds.filter((id) => id !== sessionId),
        hiddenSessionIds: current.hiddenSessionIds.filter((id) => id !== sessionId),
      });
      await this.persist(preferences);
      return preferences;
    });
  }
}
