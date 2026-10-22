import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CONTENT_TEXT_SIZES,
  DESKTOP_SEND_KEYS,
  defaultPreferences,
  type InspirePreferences,
  MAX_SESSION_ID_CHARS,
  migratePalettePreference,
  PALETTE_PREFERENCES,
  READING_WIDTHS,
  SESSION_ACTION_IDS,
} from "../shared/contracts.js";
import { acquireFileLock } from "./file-lock.mjs";
import { inspireConfigDirectory } from "./platform-paths.mjs";
import { ProjectDirectoryStore } from "./project-directories.js";
import { requestError } from "./request-error.js";

// Field validators stay default-free here: `.partial()` keeps `.default()`,
// so a patch schema derived from defaulted fields would fill absent keys and
// clobber stored values on every patch.
const preferenceFields = {
  herdrEnabled: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  palette: z
    .enum([...PALETTE_PREFERENCES, "amber", "teal"])
    .transform(migratePalettePreference),
  titlebarNeedles: z.boolean(),
  contentTextSize: z.enum(CONTENT_TEXT_SIZES),
  readingWidth: z.enum(READING_WIDTHS),
  launch: z.enum(["welcome", "continue"]),
  desktopSendKey: z.enum(DESKTOP_SEND_KEYS),
  thinkingVisibility: z.enum(["dynamic", "expanded", "collapsed", "hidden"]),
  toolVisibility: z.enum([
    "dynamic",
    "expanded",
    "compact",
    "collapsed",
    "hidden",
  ]),
  activityFoldVisibility: z.enum([
    "dynamic",
    "expanded",
    "compact",
    "collapsed",
  ]),
  projectDisplay: z.enum(["folder", "path"]),
  sessionActionOrder: z
    .array(z.enum(SESSION_ACTION_IDS))
    .max(SESSION_ACTION_IDS.length)
    .refine((order) => new Set(order).size === order.length, {
      message: "Session actions must not repeat",
    })
    // New actions join the end without discarding a saved order.
    .transform((order) => [
      ...order,
      ...SESSION_ACTION_IDS.filter((id) => !order.includes(id)),
    ]),
  completionAttention: z.enum(["off", "title", "desktop"]),
  recentModelIds: z
    .array(
      z.object({
        provider: z.string().min(1).max(120),
        id: z.string().min(1).max(240),
      }),
    )
    .max(8),
  pinnedSessionIds: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(100),
  pinnedProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenSessionIds: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(500),
  navCollapsedGroups: z.array(z.string().min(1).max(4_096)).max(500),
  terminalSessionIds: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(500),
};

const preferencesSchema = z.object(preferenceFields).strict();

// Writes are field-scoped patches merged over the stored file, never full
// snapshots, so concurrent writers can only contend on the fields they
// actually changed. Reject unknown patch fields, but preserve existing fields
// belonging to other versions of Inspire.
const preferencesPatchSchema = preferencesSchema.partial().strict();

interface DiskPreferences {
  preferences: InspirePreferences;
  /** Absent only when the file cannot be safely patched as a JSON object. */
  source?: Record<string, unknown>;
  warning?: string;
}

interface PreferencesInspection {
  preferences: InspirePreferences;
  warning?: string;
}

function projectPreferences(value: unknown): DiskPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      preferences: structuredClone(defaultPreferences),
      warning:
        "Saved preferences have an invalid root value. Repair or remove the file before changing settings.",
    };
  }

  const source = { ...(value as Record<string, unknown>) };
  // Retired preference; unlike unknown fields, this has a known migration.
  delete source.assistantRoundDisplay;
  const normalized = structuredClone(defaultPreferences) as unknown as Record<
    string,
    unknown
  >;
  const invalid: string[] = [];
  for (const [field, schema] of Object.entries(preferenceFields)) {
    if (!Object.hasOwn(source, field)) continue;
    const parsed = schema.safeParse(source[field]);
    if (parsed.success) {
      normalized[field] = parsed.data;
      source[field] = parsed.data;
    } else invalid.push(field);
  }
  const issueSummary =
    invalid.length <= 8
      ? invalid.join(", ")
      : `${invalid.slice(0, 8).join(", ")}, and ${invalid.length - 8} more`;
  return {
    source,
    preferences: preferencesSchema.parse(normalized),
    ...(invalid.length > 0
      ? {
          warning: `Some saved preferences are invalid (${issueSummary}). Defaults are shown for those fields. Change them in Settings to repair them; other settings remain editable.`,
        }
      : {}),
  };
}

export class PreferencesStore {
  readonly path: string;
  readonly projectDirectories: ProjectDirectoryStore;
  private writes: Promise<void> = Promise.resolve();

  constructor(path = join(inspireConfigDirectory(), "preferences.json")) {
    this.path = path;
    this.projectDirectories = new ProjectDirectoryStore(
      `${path}.projects.json`,
    );
  }

  private async readDisk(): Promise<DiskPreferences> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { preferences: structuredClone(defaultPreferences), source: {} };
      }
      throw error;
    }

    try {
      return projectPreferences(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          preferences: structuredClone(defaultPreferences),
          warning:
            "Saved preferences are not valid JSON. Repair or remove the file before changing settings.",
        };
      }
      throw error;
    }
  }

  async inspect(): Promise<PreferencesInspection> {
    return this.enqueue(async () => {
      const current = await this.readDisk();
      return {
        preferences: current.preferences,
        ...(current.warning
          ? {
              warning: `${current.warning} The saved file at ${this.path} was left unchanged.`,
            }
          : {}),
      };
    });
  }

  async read(): Promise<InspirePreferences> {
    return (await this.inspect()).preferences;
  }

  private async withWriteLock<T>(
    operation: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const lease = await acquireFileLock(`${this.path}.flock`, {
      label: "saved preferences",
    });
    try {
      await lease.assertOwned();
      return await operation(lease.assertOwned);
    } finally {
      await lease.release();
    }
  }

  private async persist(
    preferences: Record<string, unknown>,
    assertOwned: () => Promise<void>,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await assertOwned();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private mutate(
    transform: (current: InspirePreferences) => unknown,
  ): Promise<InspirePreferences> {
    return this.enqueue(() =>
      this.withWriteLock(async (assertOwned) => {
        const current = await this.readDisk();
        if (!current.source)
          throw requestError(
            `${current.warning} The saved file at ${this.path} was left unchanged.`,
            409,
          );
        const patch = preferencesPatchSchema.parse(
          transform(current.preferences),
        );
        const source = { ...current.source, ...patch };
        const { preferences } = projectPreferences(source);
        // Curation can introduce discovery roots, never remove them. Save both
        // sides before replacing legacy preferences, including deletion cleanup.
        await this.projectDirectories.remember([
          ...current.preferences.pinnedProjectCwds,
          ...current.preferences.hiddenProjectCwds,
          ...preferences.pinnedProjectCwds,
          ...preferences.hiddenProjectCwds,
        ]);
        await this.persist(source, assertOwned);
        return preferences;
      }),
    );
  }

  async setTerminalSession(
    sessionId: string,
    terminal: boolean,
  ): Promise<void> {
    await this.mutate((current) => ({
      terminalSessionIds: terminal
        ? [...new Set([...current.terminalSessionIds, sessionId])]
        : current.terminalSessionIds.filter((id) => id !== sessionId),
    }));
  }

  async patch(value: unknown): Promise<InspirePreferences> {
    const patch = preferencesPatchSchema.parse(value);
    return this.mutate(() => patch);
  }

  /** The read/transform/write stays in one serialized preference operation,
   * so concurrent curation patches cannot be overwritten by deletion cleanup. */
  private removeNavigationIdentities(
    deletedSessionIds: readonly string[],
    clearedHiddenSessionIds: readonly string[],
    clearedProjectCwds: readonly string[],
  ): Promise<InspirePreferences> {
    const deleted = new Set(deletedSessionIds);
    const clearedHidden = new Set(clearedHiddenSessionIds);
    const clearedProjects = new Set(clearedProjectCwds);
    return this.mutate((current) => ({
      terminalSessionIds: current.terminalSessionIds.filter(
        (id) => !deleted.has(id),
      ),
      pinnedSessionIds: current.pinnedSessionIds.filter(
        (id) => !deleted.has(id),
      ),
      hiddenSessionIds: current.hiddenSessionIds.filter(
        (id) => !clearedHidden.has(id),
      ),
      pinnedProjectCwds: current.pinnedProjectCwds.filter(
        (cwd) => !clearedProjects.has(cwd),
      ),
      hiddenProjectCwds: current.hiddenProjectCwds.filter(
        (cwd) => !clearedProjects.has(cwd),
      ),
      navCollapsedGroups: current.navCollapsedGroups.filter(
        (cwd) => !clearedProjects.has(cwd),
      ),
    }));
  }

  /** Remove the committed subset of a Hidden clear. Only a complete clear
   * removes the reviewed curation snapshot; a partial filesystem result keeps
   * folder ownership for the sessions that remain. */
  removeClearedHidden(
    deletedSessionIds: readonly string[],
    reviewedHiddenSessionIds: readonly string[],
    reviewedHiddenProjectCwds: readonly string[],
    complete: boolean,
  ): Promise<InspirePreferences> {
    return this.removeNavigationIdentities(
      deletedSessionIds,
      complete
        ? [...deletedSessionIds, ...reviewedHiddenSessionIds]
        : deletedSessionIds,
      complete ? reviewedHiddenProjectCwds : [],
    );
  }

  removeSession(sessionId: string): Promise<InspirePreferences> {
    return this.removeNavigationIdentities([sessionId], [sessionId], []);
  }
}
