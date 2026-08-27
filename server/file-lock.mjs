import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processStartIdentity } from "./instance-state.mjs";

const FILE_LOCK_VERSION = 1;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_INVALID_STALE_MS = 30_000;
const DEFAULT_INITIALIZATION_GRACE_MS = 1_000;

function lockError(message, code) {
  return Object.assign(new Error(message), { code, status: 503 });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validOwner(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.schemaVersion === FILE_LOCK_VERSION &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.processStartTime === "string" &&
      value.processStartTime.length > 0 &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
}

async function readOwner(path, metadata) {
  try {
    const info = metadata ?? (await stat(path));
    const ownerPath = info.isDirectory() ? join(path, "owner.json") : path;
    const raw = await readFile(ownerPath, "utf8");
    const value = JSON.parse(raw);
    if (validOwner(value)) return { owner: value, raw, legacy: false };
    if (Number.isInteger(value?.pid) && value.pid > 0) {
      return {
        owner: {
          schemaVersion: 0,
          pid: value.pid,
          token: null,
          processStartTime: null,
          createdAt: null,
        },
        raw,
        legacy: true,
      };
    }
    return { owner: null, raw, legacy: info.isDirectory() };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { owner: null, raw: null, legacy: false };
  }
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH" ? false : true;
  }
  return true;
}

async function ownerAlive(owner) {
  if (!(await processAlive(owner.pid))) return false;
  // Legacy and fallback records have only a PID. Preserve their conservative
  // semantics: a recycled live PID may delay recovery, but it cannot overlap
  // two writers. Versioned records compare the OS process-birth identity so a
  // recycled PID does not hold a crashed lock forever.
  if (
    typeof owner.processStartTime !== "string" ||
    owner.processStartTime.startsWith("pid:")
  )
    return true;
  try {
    return (
      (await processStartIdentity(owner.pid)) === owner.processStartTime
    );
  } catch {
    return true;
  }
}

let currentProcessIdentity;

function ownProcessStartIdentity() {
  currentProcessIdentity ??= processStartIdentity(process.pid).catch(
    () => `pid:${process.pid}`,
  );
  return currentProcessIdentity;
}

async function restoreClaim(path, claimed) {
  try {
    await rename(claimed, path);
  } catch (error) {
    const code = error?.code;
    if (code !== "ENOENT" && code !== "EEXIST" && code !== "EPERM")
      throw error;
  }
}

async function claimObserved(path, observation, label) {
  const claimed = `${path}.${label}-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, claimed);
  } catch (error) {
    const code = error?.code;
    if (
      code === "ENOENT" ||
      code === "EEXIST" ||
      code === "EACCES" ||
      code === "EPERM"
    )
      return null;
    throw error;
  }

  const claimedStat = await stat(claimed).catch(() => null);
  if (
    !claimedStat ||
    !sameIdentity(observation.identity, {
      dev: claimedStat.dev,
      ino: claimedStat.ino,
    })
  ) {
    await restoreClaim(path, claimed);
    return null;
  }
  const claimedOwner = await readOwner(claimed, claimedStat);
  if (
    observation.token !== null
      ? claimedOwner?.owner?.token !== observation.token
      : claimedOwner?.raw !== observation.raw
  ) {
    await restoreClaim(path, claimed);
    return null;
  }
  return claimed;
}

async function observedLock(path) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata) return null;
  const decoded = await readOwner(path, metadata);
  if (!decoded) return null;
  return {
    identity: { dev: metadata.dev, ino: metadata.ino },
    modifiedAt: metadata.mtimeMs,
    owner: decoded.owner,
    token: decoded.owner?.token ?? null,
    raw: decoded.raw,
    directory: metadata.isDirectory(),
  };
}

async function reclaimIfAbandoned(path, options) {
  const observed = await observedLock(path);
  if (!observed) return true;
  if (observed.owner) {
    if (await ownerAlive(observed.owner)) return false;
  } else if (
    Date.now() - observed.modifiedAt <
    options.invalidStaleMs
  ) {
    return false;
  }

  const claimed = await claimObserved(path, observed, "reclaim");
  if (!claimed) return true;
  await rm(claimed, { recursive: observed.directory, force: true });
  return true;
}

async function installOwner(path, owner) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Acquire one cross-process lock without shelling out to platform utilities.
 * The owner file is installed with O_EXCL, retained for the lease lifetime,
 * and reclaimed only after the recorded process identity is no longer alive.
 */
export async function acquireFileLock(path, suppliedOptions = {}) {
  const options = {
    waitMs: suppliedOptions.waitMs ?? DEFAULT_WAIT_MS,
    retryMs: suppliedOptions.retryMs ?? DEFAULT_RETRY_MS,
    invalidStaleMs:
      suppliedOptions.invalidStaleMs ?? DEFAULT_INVALID_STALE_MS,
    initializationGraceMs:
      suppliedOptions.initializationGraceMs ??
      DEFAULT_INITIALIZATION_GRACE_MS,
    label: suppliedOptions.label ?? "file",
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = {
    schemaVersion: FILE_LOCK_VERSION,
    pid: process.pid,
    token: randomUUID(),
    processStartTime: await ownProcessStartIdentity(),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + options.waitMs;
  let handle = null;
  while (!handle) {
    handle = await installOwner(path, owner);
    if (handle) break;
    const observed = await observedLock(path);
    if (
      observed &&
      !observed.owner &&
      Date.now() - observed.modifiedAt < options.initializationGraceMs
    ) {
      // Another process has atomically created the path and is still writing
      // its small owner record. Treat this as held, not corrupt or stale.
    } else {
      await reclaimIfAbandoned(path, options);
    }
    if (Date.now() >= deadline) {
      throw lockError(
        `Timed out waiting for the ${options.label} lock`,
        "ELOCKTIMEOUT",
      );
    }
    await delay(Math.min(options.retryMs, Math.max(1, deadline - Date.now())));
  }

  const handleStat = await handle.stat();
  const identity = { dev: handleStat.dev, ino: handleStat.ino };
  let released = false;
  const assertOwned = async () => {
    if (released)
      throw lockError(`${options.label} lock is already released`, "ERELEASED");
    const [pathStat, decoded] = await Promise.all([
      stat(path).catch(() => null),
      readOwner(path),
    ]);
    if (
      !pathStat ||
      !sameIdentity(identity, { dev: pathStat.dev, ino: pathStat.ino }) ||
      decoded?.owner?.token !== owner.token
    ) {
      throw lockError(
        `${options.label} lock changed ownership while in use`,
        "ECOMPROMISED",
      );
    }
  };
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => undefined);
    const observed = await observedLock(path);
    if (
      !observed ||
      !sameIdentity(identity, observed.identity) ||
      observed.owner?.token !== owner.token
    )
      return;
    const claimed = await claimObserved(path, observed, "release");
    if (!claimed) return;
    await rm(claimed, { recursive: observed.directory, force: true });
  };
  try {
    // O_EXCL wins the path creation race, but another actor could still rename
    // the path while the small owner record is being written. Never hand out a
    // lease until the published path is proven to be this exact open inode and
    // token.
    await assertOwned();
  } catch (error) {
    await release();
    throw error;
  }
  return {
    path,
    owner,
    assertOwned,
    release,
  };
}
