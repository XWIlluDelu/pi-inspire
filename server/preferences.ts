import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CONTENT_TEXT_SIZES,
  defaultPreferences,
  DESKTOP_SEND_KEYS,
  READING_WIDTHS,
  type InspirePreferences,
} from "../shared/contracts.js";

// Field validators stay default-free here: `.partial()` keeps `.default()`,
// so a patch schema derived from defaulted fields would fill absent keys and
// clobber stored values on every patch.
const preferenceFields = {
  theme: z.enum(["system", "light", "dark"]),
  palette: z.enum(["amber", "teal"]),
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

interface PreferencesInspection {
  preferences: InspirePreferences;
  warning?: string;
}

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";

interface LockOwner {
  pid: number;
  token: string | null;
}

interface LockIdentity {
  dev: number;
  ino: number;
}

async function readLockOwner(lock: string): Promise<LockOwner | null> {
  try {
    const lockStat = await stat(lock);
    const ownerPath = lockStat.isDirectory()
      ? join(lock, LOCK_OWNER_FILE)
      : lock;
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0) return null;
    return {
      pid: Number(owner.pid),
      token:
        typeof owner.token === "string" && owner.token.length > 0
          ? owner.token
          : null,
    };
  } catch {
    return null;
  }
}

async function tryAcquireWriteLock(lock: string): Promise<string | null> {
  const token = randomUUID();
  const candidate = `${lock}.candidate-${process.pid}-${token}`;
  try {
    await writeFile(
      candidate,
      `${JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    try {
      // A hard link installs the fully written owner record atomically and
      // never replaces an existing file or legacy directory lock.
      await link(candidate, lock);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined);
  }
}

function lockOwnerAlive(owner: LockOwner | null): boolean | null {
  if (!owner) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

function sameLockIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLockOwner(
  left: LockOwner | null,
  right: LockOwner | null,
): boolean {
  return left?.pid === right?.pid && left?.token === right?.token;
}

async function restoreClaimedLock(
  lock: string,
  claimed: string,
): Promise<void> {
  try {
    await rename(claimed, lock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw error;
  }
}

async function claimLockDirectory(
  lock: string,
  expectedIdentity: LockIdentity,
  purpose: "release" | "stale",
): Promise<string | null> {
  const claimed = `${lock}.${purpose}-${process.pid}-${randomUUID()}`;
  try {
    await rename(lock, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const claimedStat = await stat(claimed).catch(() => null);
  if (
    claimedStat &&
    sameLockIdentity(expectedIdentity, {
      dev: claimedStat.dev,
      ino: claimedStat.ino,
    })
  ) {
    return claimed;
  }

  await restoreClaimedLock(lock, claimed);
  return null;
}

function compromisedLockError(): Error {
  return Object.assign(
    new Error("Saved preferences changed ownership while being updated"),
    { status: 503 },
  );
}

async function assertOwnedLock(lock: string, token: string): Promise<void> {
  if ((await readLockOwner(lock))?.token !== token)
    throw compromisedLockError();
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
  const owner = await readLockOwner(lock);
  if (owner?.token !== token) return;
  const lockStat = await stat(lock).catch(() => null);
  if (!lockStat || (await readLockOwner(lock))?.token !== token) return;
  const claimed = await claimLockDirectory(
    lock,
    { dev: lockStat.dev, ino: lockStat.ino },
    "release",
  );
  if (!claimed) return;
  if ((await readLockOwner(claimed))?.token !== token) {
    await restoreClaimedLock(lock, claimed);
    return;
  }
  await rm(claimed, { recursive: true, force: true });
}

async function reclaimObservedLock(
  lock: string,
  identity: LockIdentity,
  owner: LockOwner | null,
): Promise<boolean> {
  const claimed = await claimLockDirectory(lock, identity, "stale");
  if (!claimed) return false;
  if (!sameLockOwner(owner, await readLockOwner(claimed))) {
    await restoreClaimedLock(lock, claimed);
    return false;
  }
  await rm(claimed, { recursive: true, force: true });
  return true;
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

  private async withWriteLock<T>(
    operation: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const parent = dirname(this.path);
    const lock = `${this.path}.lock`;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    let ownerToken: string | null = null;
    while (ownerToken === null) {
      ownerToken = await tryAcquireWriteLock(lock);
      if (ownerToken !== null) break;
      const lockStat = await stat(lock).catch(() => null);
      if (!lockStat) continue;
      const lockAge = Date.now() - lockStat.mtimeMs;
      const owner = await readLockOwner(lock);
      const ownerAlive = lockOwnerAlive(owner);
      if (
        ownerAlive === false ||
        (ownerAlive === null && lockAge > STALE_LOCK_MS)
      ) {
        const reclaimed = await reclaimObservedLock(
          lock,
          { dev: lockStat.dev, ino: lockStat.ino },
          owner,
        );
        if (reclaimed) continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw Object.assign(
          new Error("Timed out waiting to update saved preferences"),
          { status: 503 },
        );
      }
      await delay(LOCK_RETRY_MS);
    }
    const token = ownerToken;
    try {
      return await operation(() => assertOwnedLock(lock, token));
    } finally {
      await releaseOwnedLock(lock, token);
    }
  }

  private async persist(
    preferences: InspirePreferences,
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
        const invalid = this.invalidSourceError(current);
        if (invalid) throw invalid;
        const preferences = preferencesSchema.parse(
          transform(current.preferences),
        );
        await this.persist(preferences, assertOwned);
        return preferences;
      }),
    );
  }

  async patch(value: unknown): Promise<InspirePreferences> {
    const patch = preferencesPatchSchema.parse(value);
    return this.mutate((current) => ({ ...current, ...patch }));
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
      ...current,
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
