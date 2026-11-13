import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultPreferences,
  type InspirePreferences,
  type PreferencePublication,
} from "../shared/contracts.js";
import {
  preferenceFields,
  preferencesPatchSchema,
  preferencesSchema,
} from "../shared/preferences-schema.js";
import { acquireFileLock } from "./file-lock.mjs";
import { inspireConfigDirectory } from "./platform-paths.mjs";
import { replacePrivateStateFile } from "./private-state-file.js";
import { ProjectDirectoryStore } from "./project-directories.js";
import { requestError } from "./request-error.js";

interface DiskPreferences {
  preferences: InspirePreferences;
  /** Absent only when the file cannot be safely patched as a JSON object. */
  source?: Record<string, unknown>;
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
  private revision = 0;

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

  async inspect(): Promise<PreferencePublication & { warning?: string }> {
    return this.enqueue(async () => {
      const current = await this.readDisk();
      return {
        preferences: current.preferences,
        revision: ++this.revision,
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
    await replacePrivateStateFile(
      this.path,
      `${JSON.stringify(preferences, null, 2)}\n`,
      { beforeReplace: assertOwned },
    );
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
  ): Promise<PreferencePublication> {
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
        if (
          patch.pinnedProjectCwds !== undefined ||
          patch.hiddenProjectCwds !== undefined
        ) {
          // Save both sides before replacing legacy folder curation.
          await this.projectDirectories.remember([
            ...current.preferences.pinnedProjectCwds,
            ...current.preferences.hiddenProjectCwds,
            ...preferences.pinnedProjectCwds,
            ...preferences.hiddenProjectCwds,
          ]);
        }
        await this.persist(source, assertOwned);
        return { preferences, revision: ++this.revision };
      }),
    );
  }

  async patch(value: unknown): Promise<PreferencePublication> {
    const patch = preferencesPatchSchema.parse(value);
    return this.mutate((current) => ({
      ...patch,
      ...(patch.adapterEnabled
        ? {
            adapterEnabled: {
              ...current.adapterEnabled,
              ...patch.adapterEnabled,
            },
          }
        : {}),
    }));
  }

  /** The read/transform/write stays in one serialized preference operation,
   * so concurrent curation patches cannot be overwritten by deletion cleanup. */
  removeDeletedSessions(
    deletedSessionIds: readonly string[],
    cleared?: {
      hiddenSessionIds: readonly string[];
      hiddenProjectCwds: readonly string[];
    },
  ): Promise<PreferencePublication> {
    const deleted = new Set(deletedSessionIds);
    const clearedHidden = new Set([
      ...deleted,
      ...(cleared?.hiddenSessionIds ?? []),
    ]);
    const clearedProjects = new Set(cleared?.hiddenProjectCwds);
    return this.mutate((current) => ({
      pinnedSessionIds: current.pinnedSessionIds.filter(
        (id) => !deleted.has(id),
      ),
      hiddenSessionIds: current.hiddenSessionIds.filter(
        (id) => !clearedHidden.has(id),
      ),
      ...(clearedProjects.size > 0
        ? {
            pinnedProjectCwds: current.pinnedProjectCwds.filter(
              (cwd) => !clearedProjects.has(cwd),
            ),
            hiddenProjectCwds: current.hiddenProjectCwds.filter(
              (cwd) => !clearedProjects.has(cwd),
            ),
            navCollapsedGroups: current.navCollapsedGroups.filter(
              (cwd) => !clearedProjects.has(cwd),
            ),
          }
        : {}),
    }));
  }
}
