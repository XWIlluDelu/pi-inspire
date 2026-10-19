import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acquireFileLock } from "./file-lock.mjs";
import { processStartIdentity } from "./instance-state.mjs";
import { inspireStateDirectory } from "./platform-paths.mjs";
import {
  isStorageVolumeIdentity,
  resolveStorageVolume,
  sameStorageVolume,
  type StorageVolumeIdentity,
  type StorageVolumeOptions,
} from "./storage-volume.js";

export const RETENTION_MARKER = ".inspire-upload-retention-root.json";
export const RETENTION_REGISTRY = ".session-directories.json";
const LOCK = ".inspire-retention-maintenance.lock";
const LEASE = ".inspire-retention-active-";
export const defaultAttachmentParent = () =>
  join(inspireStateDirectory(), "attachments");

export interface RootIdentity {
  directory: string;
  id: string;
  volume?: StorageVolumeIdentity;
}
export interface RootSnapshot extends RootIdentity {
  rootVersion: string;
  markerVersion: string;
  created?: boolean;
}
interface DirectoryRegistry {
  directories: string[];
  identities: Record<string, RootIdentity>;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function absolute(value: unknown): value is string {
  return (
    typeof value === "string" && isAbsolute(value) && !value.includes("\0")
  );
}
export function sameRootIdentity(a: RootIdentity, b: RootIdentity): boolean {
  return a.id === b.id;
}
function version(value: BigIntStats): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
    ":",
  );
}
async function root(path: string) {
  const directory = await realpath(path);
  const stats = await stat(directory, { bigint: true });
  if (!stats.isDirectory())
    throw new Error("Session retention root is not a directory");
  return { directory, rootVersion: [stats.dev, stats.ino].join(":") };
}

/** Namespace continuity, not a secret or hardware identifier. Creation never
 * overwrites any entry; malformed/partial/replaced markers always fail closed. */
export async function readRootIdentity(
  path: string,
  create = false,
  createId?: string,
): Promise<RootSnapshot> {
  if (createId !== undefined && !uuid.test(createId))
    throw new Error("Invalid retention namespace ID");
  let created = false;
  const beforeRoot = await root(path);
  const marker = join(beforeRoot.directory, RETENTION_MARKER);
  if (create) {
    try {
      const output = await open(marker, "wx", 0o600);
      try {
        await output.writeFile(
          JSON.stringify({
            format: "inspire-upload-retention-root",
            version: 1,
            id: createId ?? randomUUID(),
          }) + "\n",
        );
        await output.sync();
        created = true;
      } finally {
        await output.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const before = await lstat(marker, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > 1024n
  )
    throw new Error("Invalid session retention marker");
  if (
    process.platform !== "win32" &&
    ((before.mode & 0o022n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())))
  )
    throw new Error(
      "Session retention marker is writable by another account or has an unexpected owner",
    );
  const handle = await open(
    marker,
    constants.O_RDONLY |
      (process.platform === "win32"
        ? 0
        : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)),
  );
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || version(initial) !== version(before))
      throw new Error("Session retention marker changed while opening");
    // Never read unbounded data after a concurrent append.
    const buffer = Buffer.alloc(1025);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
    const afterRoot = await root(path);
    if (
      beforeRoot.directory !== afterRoot.directory ||
      beforeRoot.rootVersion !== afterRoot.rootVersion ||
      version(await handle.stat({ bigint: true })) !== version(initial) ||
      version(await lstat(marker, { bigint: true })) !== version(initial)
    )
      throw new Error(
        "Session retention storage changed while reading its marker",
      );
    if (
      value?.format !== "inspire-upload-retention-root" ||
      value.version !== 1 ||
      typeof value.id !== "string" ||
      !uuid.test(value.id) ||
      length > 1024
    )
      throw new Error("Invalid session retention marker");
    return {
      ...afterRoot,
      id: value.id,
      markerVersion: version(initial),
      created,
    };
  } finally {
    await handle.close();
  }
}

export async function verifyRootSnapshot(
  path: string,
  expected: RootSnapshot,
): Promise<void> {
  const actual = await readRootIdentity(path);
  if (
    !sameRootIdentity(expected, actual) ||
    expected.directory !== actual.directory ||
    expected.rootVersion !== actual.rootVersion ||
    expected.markerVersion !== actual.markerVersion
  )
    throw new Error(
      "Session retention storage changed during attachment reclamation",
    );
}

export function parseDirectoryRegistry(value: unknown): DirectoryRegistry {
  const record = value as {
    version?: unknown;
    directories?: unknown;
    identities?: unknown;
    linuxMounts?: unknown;
  } | null;
  const legacy = Array.isArray(value);
  const directories: unknown = legacy ? value : record?.directories;
  if (
    (!legacy && record?.version !== 2 && record?.version !== 3) ||
    !Array.isArray(directories) ||
    directories.some((path) => !absolute(path))
  )
    throw new Error("Invalid attachment session-directory registry");
  const identities: Record<string, RootIdentity> = Object.create(null);
  if (!legacy && record?.version === 3) {
    if (
      !record.identities ||
      typeof record.identities !== "object" ||
      Array.isArray(record.identities)
    )
      throw new Error("Invalid attachment retention identities");
    for (const [path, identity] of Object.entries(record.identities)) {
      if (
        !directories.includes(path) ||
        !identity ||
        typeof identity !== "object" ||
        !absolute(identity.directory) ||
        typeof identity.id !== "string" ||
        !uuid.test(identity.id)
      )
        throw new Error("Invalid attachment retention root identity");
      if (
        identity.volume !== undefined &&
        !isStorageVolumeIdentity(identity.volume)
      )
        throw new Error("Invalid persistent session volume identity");
      identities[path] = {
        directory: identity.directory,
        id: identity.id,
        ...(identity.volume ? { volume: identity.volume } : {}),
      };
    }
  }
  // v1 paths and v2 topology have no historical namespace identity. Preserve
  // every path but never bootstrap them from today's path/Pi-header contents.
  return { directories: [...new Set(directories as string[])], identities };
}

export async function writeDirectoryRegistry(
  path: string,
  registry: DirectoryRegistry,
): Promise<void> {
  const temporary = join(dirname(path), `.retention-registry-${randomUUID()}`);
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(
        JSON.stringify({ version: 3, ...registry }) + "\n",
      );
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function assertNoRetentionMaintenance(
  parent: string,
): Promise<void> {
  const lease = await acquireFileLock(join(parent, LOCK), {
    waitMs: 0,
    label: "attachment retention maintenance",
  });
  await lease.release();
}

/** The established kernel/birth-bound lock protocol recovers crashed owners.
 * Startup lease publication and all normal registry writers share migration's gate. */
export async function withRetentionMaintenance<T>(
  parent: string,
  work: () => Promise<T>,
  wait = false,
): Promise<T> {
  const lease = await acquireFileLock(join(parent, LOCK), {
    waitMs: wait ? 5000 : 0,
    label: "attachment retention maintenance",
  });
  try {
    await lease.assertOwned();
    const result = await work();
    await lease.assertOwned();
    return result;
  } finally {
    await lease.release();
  }
}

let ownStart: Promise<string> | undefined;
export function retentionProcessIdentity(): Promise<string> {
  return (ownStart ??= processStartIdentity(process.pid).catch(
    () => `pid:${process.pid}`,
  ));
}

export async function retentionOwnerAlive(
  pid: number,
  start?: string,
): Promise<boolean> {
  if (!processAlive(pid)) return false;
  if (!start || start.startsWith("pid:")) return true;
  try {
    return (await processStartIdentity(pid)) === start;
  } catch {
    return true;
  } // Inaccessibility is not proof that an owner stopped.
}

export async function createRetentionLease(
  uploadRoot: string,
): Promise<() => Promise<void>> {
  const path = join(uploadRoot, `${LEASE}${process.pid}-${randomUUID()}`);
  const handle = await open(path, "wx", 0o600);
  const initial = await handle.stat({ bigint: true });
  try {
    await handle.writeFile(
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartTime: await retentionProcessIdentity(),
      }) + "\n",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return async () => {
    const current = await lstat(path, { bigint: true }).catch(() => null);
    if (current?.dev === initial.dev && current.ino === initial.ino)
      await unlink(path);
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function assertInactive(uploadRoot: string): Promise<void> {
  const raw = await readFile(join(uploadRoot, RETENTION_REGISTRY), "utf8").then(
    (value) => JSON.parse(value),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  if (raw && (Array.isArray(raw) || raw?.version !== 3)) {
    const owner = Number(
      /^([0-9]+)-[0-9]+-/u.exec(uploadRoot.split(/[\\/]/u).at(-1) ?? "")?.[1],
    );
    if (!Number.isSafeInteger(owner) || processAlive(owner))
      throw new Error(
        `Cannot establish that the legacy Host is stopped: ${uploadRoot}`,
      );
  }
  for (const entry of await readdir(uploadRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(LEASE)) {
      const pid = Number(entry.name.slice(LEASE.length).split("-")[0]);
      if (!entry.isFile() || !Number.isSafeInteger(pid))
        throw new Error(`Unknown Host retention lease: ${uploadRoot}`);
      let start: string | undefined;
      try {
        const leasePath = join(uploadRoot, entry.name);
        if ((await lstat(leasePath)).size > 1024)
          throw new Error("Unbounded retention lease metadata");
        const owner = JSON.parse(await readFile(leasePath, "utf8"));
        if (
          owner?.version === 1 &&
          owner.pid === pid &&
          typeof owner.processStartTime === "string" &&
          owner.processStartTime
        )
          start = owner.processStartTime;
      } catch {
        /* Old/unknown metadata remains PID-conservative. */
      }
      if (await retentionOwnerAlive(pid, start))
        throw new Error(
          `Stop every affected Host before trusting storage: ${uploadRoot}`,
        );
    } else if (/^[0-9a-f-]{36}\.json$/u.test(entry.name)) {
      const value = JSON.parse(
        await readFile(join(uploadRoot, entry.name), "utf8"),
      );
      if (
        !Number.isInteger(value.ownerPid) ||
        (await retentionOwnerAlive(
          value.ownerPid,
          typeof value.ownerStartTime === "string"
            ? value.ownerStartTime
            : undefined,
        ))
      )
        throw new Error(
          `An affected upload owner may still be running: ${uploadRoot}`,
        );
    }
  }
}

interface TrustOptions {
  parent?: string;
  roots?: readonly string[];
  confirm?: boolean;
  acceptReplacement?: boolean;
  volume?: Omit<StorageVolumeOptions, "parent">;
}
interface TrustPlan {
  directory: string;
  marker: RootIdentity | null;
  registries: string[];
  unverifiedRegistries: number;
  expectedIdentities: RootIdentity[];
  currentVolume: StorageVolumeIdentity | null;
  requiresReplacement: boolean;
}
async function planTrust(directory: string, options: TrustOptions) {
  if (!absolute(directory))
    throw new Error("Supply an absolute session directory");
  const actual = await realpath(directory);
  if (!(await stat(actual)).isDirectory())
    throw new Error("Session storage is not a directory");
  const parent = resolve(options.parent ?? defaultAttachmentParent());
  const roots =
    options.roots ??
    (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+-\d+-/u.test(entry.name))
      .map((entry) => join(parent, entry.name));
  const canonicalParent = await realpath(parent);
  for (const uploadRoot of roots)
    if (dirname(await realpath(uploadRoot)) !== canonicalParent)
      throw new Error(
        "Every affected upload root must be directly inside its locked parent",
      );
  const registries: Array<{ path: string; registry: DirectoryRegistry }> = [];
  let marker: RootSnapshot | null;
  try {
    const current = await readRootIdentity(directory);
    marker = current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    marker = null;
  }
  for (const uploadRoot of roots) {
    const path = join(uploadRoot, RETENTION_REGISTRY);
    const registry = await readFile(path, "utf8").then(
      (text) => parseDirectoryRegistry(JSON.parse(text)),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    if (!registry?.directories.includes(directory)) continue;
    registries.push({ path, registry });
  }
  const expectedIds = new Set(
    registries
      .map(({ registry }) => registry.identities[directory]?.id)
      .filter((id) => id !== undefined),
  );

  if (!registries.length)
    throw new Error(
      "No retained upload registry contains this exact session-directory path",
    );
  const expectedIdentities = registries.flatMap(({ registry }) =>
    registry.identities[directory] ? [registry.identities[directory]!] : [],
  );
  let currentVolume: StorageVolumeIdentity | null = null;
  try {
    currentVolume = (
      await resolveStorageVolume(
        directory,
        { parent, ...options.volume },
        readRootIdentity,
      )
    ).identity;
  } catch (error) {
    // Missing Linux anchors can be established only by explicit confirmation.
    if (
      expectedIdentities.some((identity) => identity.volume) &&
      (options.volume?.platform ?? process.platform) !== "linux"
    )
      throw error;
  }
  const expectedVolumes = expectedIdentities.flatMap((identity) =>
    identity.volume ? [identity.volume] : [],
  );
  const requiresReplacement =
    expectedIds.size > 1 ||
    expectedVolumes.some(
      (volume) => !sameStorageVolume(volume, expectedVolumes[0]!),
    ) ||
    expectedIdentities.some(
      (expected) =>
        (marker && !sameRootIdentity(expected, marker)) ||
        (expected.volume &&
          currentVolume &&
          !sameStorageVolume(expected.volume, currentVolume)),
    );
  if (options.confirm && requiresReplacement && !options.acceptReplacement)
    throw new Error(
      "Existing marker or volume identity conflicts; --accept-replacement with --confirm is required",
    );
  return {
    parent,
    roots,
    registries,
    snapshot: marker,
    expectedId: expectedIds.size === 1 ? [...expectedIds][0] : undefined,
    expectedVolume: expectedIdentities.find((identity) => identity.volume)
      ?.volume,
    result: {
      directory,
      marker: marker ? { directory: marker.directory, id: marker.id } : null,
      registries: registries.map(({ path }) => path),
      expectedIdentities,
      currentVolume,
      requiresReplacement,
      unverifiedRegistries: registries.filter(
        ({ registry }) => !registry.identities[directory],
      ).length,
    } satisfies TrustPlan,
  };
}

/** Preview is zero-write. Confirmation asserts the complete original session
 * and Trash reference namespace is available; mistaken trust can release uploads.
 * A different existing valid marker is never overwritten/adopted silently. */
export async function trustSessionDirectory(
  directory: string,
  options: TrustOptions = {},
): Promise<TrustPlan> {
  if (options.acceptReplacement && !options.confirm)
    throw new Error("--accept-replacement requires --confirm");
  if (!options.confirm) return (await planTrust(directory, options)).result;
  const parent = resolve(options.parent ?? defaultAttachmentParent());
  return withRetentionMaintenance(parent, async () => {
    const plan = await planTrust(directory, options);
    for (const uploadRoot of plan.roots) await assertInactive(uploadRoot);
    const marker = await readRootIdentity(
      directory,
      !plan.snapshot,
      plan.expectedId,
    );
    if (plan.snapshot) {
      if (
        !sameRootIdentity(plan.snapshot, marker) ||
        plan.snapshot.directory !== marker.directory ||
        plan.snapshot.markerVersion !== marker.markerVersion ||
        plan.snapshot.rootVersion !== marker.rootVersion
      )
        throw new Error("Storage changed during explicit retention trust");
    } else if (!marker.created)
      throw new Error(
        "A retention marker appeared during trust; preview again",
      );
    const volume = await resolveStorageVolume(
      directory,
      { parent, ...options.volume },
      readRootIdentity,
      options.acceptReplacement ? undefined : plan.expectedVolume,
      true,
    );
    for (const { path, registry } of plan.registries) {
      const current = await readRootIdentity(directory);
      if (
        !sameRootIdentity(marker, current) ||
        marker.directory !== current.directory ||
        current.markerVersion !== marker.markerVersion ||
        current.rootVersion !== marker.rootVersion
      )
        throw new Error("Storage changed during explicit retention trust");
      await volume.verify();
      registry.identities[directory] = {
        directory: marker.directory,
        id: marker.id,
        volume: volume.identity,
      };
      await writeDirectoryRegistry(path, registry);
    }
    return {
      ...plan.result,
      marker: { directory: marker.directory, id: marker.id },
    };
  });
}
