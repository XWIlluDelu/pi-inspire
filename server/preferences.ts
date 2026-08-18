import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  defaultPreferences,
  type InspirePreferences,
} from "../shared/contracts.js";

// Field validators stay default-free here: `.partial()` keeps `.default()`,
// so a patch schema derived from defaulted fields would fill absent keys and
// clobber stored values on every patch.
const preferenceFields = {
  theme: z.enum(["system", "light", "dark"]),
  palette: z.enum(["amber", "teal"]),
  launch: z.enum(["welcome", "continue"]),
  thinkingVisibility: z.enum(["dynamic", "expanded", "collapsed", "hidden"]),
  toolVisibility: z.enum([
    "dynamic",
    "expanded",
    "collapsed",
    "compact",
    "hidden",
  ]),
  assistantRoundDisplay: z.enum(["details", "divider"]),
  projectDisplay: z.enum(["folder", "path"]),
  completionAttention: z.enum(["off", "title", "desktop"]),
  recentModelIds: z
    .array(
      z
        .object({
          provider: z.string().min(1).max(120),
          id: z.string().min(1).max(240),
        })
        .strict(),
    )
    .max(8),
  pinnedSessionIds: z.array(z.string().min(1).max(128)).max(100),
  pinnedProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenSessionIds: z.array(z.string().min(1).max(128)).max(500),
  navCollapsedGroups: z.array(z.string().min(1).max(4_096)).max(500),
};

const preferencesSchema = z.object(preferenceFields).strict();

// Writes are field-scoped patches merged over the stored file, never full
// snapshots, so concurrent writers can only contend on the fields they
// actually changed. `.strict()` keeps unknown keys out of the stored file.
const preferencesPatchSchema = preferencesSchema.partial().strict();

interface DiskPreferences {
  preferences: InspirePreferences;
  warning?: string;
}

export interface PreferencesInspection {
  preferences: InspirePreferences;
  warning?: string;
}

function projectPreferences(value: unknown): {
  preferences: InspirePreferences;
  warning?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      preferences: structuredClone(defaultPreferences),
      warning:
        "Saved preferences have an invalid root value. Repair or remove the file before changing settings.",
    };
  }

  const source = value as Record<string, unknown>;
  const normalized = structuredClone(defaultPreferences) as unknown as Record<
    string,
    unknown
  >;
  const invalid: string[] = [];
  for (const [field, schema] of Object.entries(preferenceFields)) {
    if (!Object.hasOwn(source, field)) continue;
    const parsed = schema.safeParse(source[field]);
    if (parsed.success) normalized[field] = parsed.data;
    else invalid.push(field);
  }
  const unknown = Object.keys(source).filter(
    (field) => !Object.hasOwn(preferenceFields, field),
  );
  const issues = [...invalid, ...unknown.map((field) => `unknown:${field}`)];
  const issueSummary =
    issues.length <= 8
      ? issues.join(", ")
      : `${issues.slice(0, 8).join(", ")}, and ${issues.length - 8} more`;
  return {
    preferences: preferencesSchema.parse(normalized),
    ...(issues.length > 0
      ? {
          warning: `Some saved preferences are invalid (${issueSummary}). Valid fields were loaded in memory; repair or remove the file before changing settings.`,
        }
      : {}),
  };
}

export class PreferencesStore {
  readonly path: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    path = join(homedir(), ".config", "inspire", "preferences.json"),
  ) {
    this.path = path;
  }

  private async readDisk(): Promise<DiskPreferences> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { preferences: structuredClone(defaultPreferences) };
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

  private invalidSourceError(current: DiskPreferences): Error | null {
    return current.warning
      ? Object.assign(
          new Error(
            `${current.warning} The saved file at ${this.path} was left unchanged.`,
          ),
          { status: 409 },
        )
      : null;
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

  private async persist(preferences: InspirePreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
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

  async patch(value: unknown): Promise<InspirePreferences> {
    const patch = preferencesPatchSchema.parse(value);
    return this.enqueue(async () => {
      const current = await this.readDisk();
      const invalid = this.invalidSourceError(current);
      if (invalid) throw invalid;
      const preferences = preferencesSchema.parse({
        ...current.preferences,
        ...patch,
      });
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
      const invalid = this.invalidSourceError(current);
      if (invalid) throw invalid;
      const preferences = preferencesSchema.parse({
        ...current.preferences,
        pinnedSessionIds: current.preferences.pinnedSessionIds.filter(
          (id) => id !== sessionId,
        ),
        hiddenSessionIds: current.preferences.hiddenSessionIds.filter(
          (id) => id !== sessionId,
        ),
      });
      await this.persist(preferences);
      return preferences;
    });
  }
}
