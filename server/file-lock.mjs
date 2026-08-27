import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
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
const PRIVATE_DIRECTORY_MODE = 0o700;
const PARTICIPANT_PATTERN =
  /^(choosing|ticket-(\d+))-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;

function lockError(message, code) {
  return Object.assign(new Error(message), { code, status: 503 });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validOwner(value, token) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.schemaVersion === FILE_LOCK_VERSION &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      value.token === token &&
      typeof value.processStartTime === "string" &&
      value.processStartTime.length > 0 &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  return true;
}

async function ownerAlive(owner) {
  if (!(await processAlive(owner.pid))) return false;
  if (owner.pid === process.pid)
    return (await ownProcessStartIdentity()) === owner.processStartTime;
  if (owner.processStartTime.startsWith("pid:")) return true;
  try {
    return (await processStartIdentity(owner.pid)) === owner.processStartTime;
  } catch {
    // Inaccessibility is not evidence that a live process lost ownership.
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

function normalizedOptions(suppliedOptions) {
  return {
    waitMs: suppliedOptions.waitMs ?? DEFAULT_WAIT_MS,
    retryMs: suppliedOptions.retryMs ?? DEFAULT_RETRY_MS,
    invalidStaleMs:
      suppliedOptions.invalidStaleMs ?? DEFAULT_INVALID_STALE_MS,
    label: suppliedOptions.label ?? "file",
    platform: suppliedOptions.platform ?? process.platform,
  };
}

async function acquireKernelLock(path, owner, options) {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw lockError(`${options.label} lock is not a regular file`, "ECOMPROMISED");
    throw error;
  }

  try {
    const seconds = Math.max(0, options.waitMs) / 1_000;
    await new Promise((resolveLock, rejectLock) => {
      let settled = false;
      const child = spawn(
        "flock",
        ["-x", "-w", String(seconds), "3"],
        {
          stdio: ["ignore", "ignore", "ignore", handle.fd],
          windowsHide: true,
        },
      );
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        operation();
      };
      child.once("error", (error) =>
        finish(() =>
          rejectLock(
            lockError(
              error?.code === "ENOENT"
                ? "flock is required for safe file locking on Linux"
                : `Could not acquire the ${options.label} lock`,
              "ELOCKUNAVAILABLE",
            ),
          ),
        ),
      );
      child.once("close", (code) =>
        finish(() => {
          if (code === 0) resolveLock();
          else
            rejectLock(
              lockError(
                code === 1
                  ? `Timed out waiting for the ${options.label} lock`
                  : `Could not acquire the ${options.label} lock`,
                code === 1 ? "ELOCKTIMEOUT" : "ELOCKUNAVAILABLE",
              ),
            );
        }),
      );
    });

    const handleStat = await handle.stat();
    if (!handleStat.isFile())
      throw lockError(`${options.label} lock is not a regular file`, "ECOMPROMISED");
    const identity = { dev: handleStat.dev, ino: handleStat.ino };
    let released = false;
    const assertOwned = async () => {
      if (released)
        throw lockError(`${options.label} lock is already released`, "ERELEASED");
      const [pathStat, currentHandleStat] = await Promise.all([
        stat(path).catch(() => null),
        handle.stat().catch(() => null),
      ]);
      if (
        !pathStat ||
        !currentHandleStat ||
        !pathStat.isFile() ||
        !sameIdentity(identity, { dev: pathStat.dev, ino: pathStat.ino }) ||
        !sameIdentity(identity, {
          dev: currentHandleStat.dev,
          ino: currentHandleStat.ino,
        })
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
    };
    try {
      await assertOwned();
    } catch (error) {
      await release();
      throw error;
    }
    return { path, owner, assertOwned, release };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function parseParticipantName(name) {
  const match = PARTICIPANT_PATTERN.exec(name);
  if (!match) return null;
  const ticket = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  if (ticket !== null && (!Number.isSafeInteger(ticket) || ticket < 1))
    return null;
  return {
    name,
    phase: match[1] === "choosing" ? "choosing" : "ticket",
    ticket,
    token: match[3],
  };
}

async function removeParticipant(path, token) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (validOwner(value, token)) await rm(path, { force: true });
  } catch {
    // A participant can disappear or change phase between observation and
    // cleanup. Its unique token is never reused, so no broader cleanup is safe
    // or necessary.
  }
}

async function inspectParticipant(directory, participant, invalidStaleMs) {
  const path = join(directory, participant.name);
  let metadata;
  let value;
  try {
    metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      return { ...participant, blocked: true };
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (
      metadata &&
      Date.now() - metadata.mtimeMs >= invalidStaleMs
    ) {
      await rm(path, { force: true }).catch(() => undefined);
      return null;
    }
    return { ...participant, blocked: true };
  }
  if (!validOwner(value, participant.token)) {
    if (Date.now() - metadata.mtimeMs >= invalidStaleMs) {
      await rm(path, { force: true }).catch(() => undefined);
      return null;
    }
    return { ...participant, blocked: true };
  }
  if (!(await ownerAlive(value))) {
    await removeParticipant(path, participant.token);
    return null;
  }
  return { ...participant, owner: value, blocked: false };
}

async function scanParticipants(directory, options) {
  const entries = await readdir(directory);
  const participants = entries
    .map(parseParticipantName)
    .filter((entry) => entry !== null);
  return (
    await Promise.all(
      participants.map((participant) =>
        inspectParticipant(directory, participant, options.invalidStaleMs),
      ),
    )
  ).filter((participant) => participant !== null);
}

async function prepareLockDirectory(path, options) {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw lockError(`${options.label} lock is not a directory`, "ECOMPROMISED");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    throw lockError(`${options.label} lock is not owned by this user`, "ECOMPROMISED");
  if (typeof process.getuid === "function" && (metadata.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  return { dev: metadata.dev, ino: metadata.ino };
}

async function publishParticipant(directory, owner) {
  const temporary = join(directory, `.initializing-${owner.token}.tmp`);
  const choosing = join(directory, `choosing-${owner.token}.json`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, choosing);
    return choosing;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquirePortableLock(path, owner, options) {
  const directoryIdentity = await prepareLockDirectory(path, options);
  const deadline = Date.now() + Math.max(0, options.waitMs);
  let participantPath = await publishParticipant(path, owner);
  try {
    const initial = await scanParticipants(path, options);
    const maximumTicket = initial.reduce(
      (maximum, participant) =>
        participant.ticket === null
          ? maximum
          : Math.max(maximum, participant.ticket),
      0,
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER)
      throw lockError(
        `${options.label} lock ticket space is exhausted`,
        "ELOCKUNAVAILABLE",
      );
    const ticket = maximumTicket + 1;
    const ticketPath = join(path, `ticket-${ticket}-${owner.token}.json`);
    await rename(participantPath, ticketPath);
    participantPath = ticketPath;
    const participantStat = await lstat(participantPath);
    const participantIdentity = {
      dev: participantStat.dev,
      ino: participantStat.ino,
    };
    const verifyOwnership = async () => {
      const [directoryStat, ownStat, raw] = await Promise.all([
        lstat(path).catch(() => null),
        lstat(participantPath).catch(() => null),
        readFile(participantPath, "utf8").catch(() => null),
      ]);
      let decoded = null;
      try {
        decoded = raw === null ? null : JSON.parse(raw);
      } catch {
        decoded = null;
      }
      if (
        !directoryStat ||
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        !sameIdentity(directoryIdentity, {
          dev: directoryStat.dev,
          ino: directoryStat.ino,
        }) ||
        !ownStat ||
        !sameIdentity(participantIdentity, {
          dev: ownStat.dev,
          ino: ownStat.ino,
        }) ||
        !validOwner(decoded, owner.token)
      )
        throw lockError(
          `${options.label} lock changed ownership while in use`,
          "ECOMPROMISED",
        );
    };

    while (true) {
      const participants = await scanParticipants(path, options);
      const blocked = participants.some((participant) => {
        if (participant.token === owner.token) return false;
        if (participant.blocked || participant.phase === "choosing") return true;
        return (
          participant.ticket < ticket ||
          (participant.ticket === ticket && participant.token < owner.token)
        );
      });
      if (!blocked) {
        await verifyOwnership();
        break;
      }
      if (Date.now() >= deadline)
        throw lockError(
          `Timed out waiting for the ${options.label} lock`,
          "ELOCKTIMEOUT",
        );
      await delay(
        Math.min(
          Math.max(1, options.retryMs),
          Math.max(1, deadline - Date.now()),
        ),
      );
    }

    let released = false;
    const assertOwned = async () => {
      if (released)
        throw lockError(
          `${options.label} lock is already released`,
          "ERELEASED",
        );
      await verifyOwnership();
    };
    const release = async () => {
      if (released) return;
      released = true;
      const directoryStat = await lstat(path).catch(() => null);
      if (
        !directoryStat ||
        !sameIdentity(directoryIdentity, {
          dev: directoryStat.dev,
          ino: directoryStat.ino,
        })
      )
        return;
      await removeParticipant(participantPath, owner.token);
    };
    try {
      await assertOwned();
    } catch (error) {
      await release();
      throw error;
    }
    return { path, owner, assertOwned, release };
  } catch (error) {
    await removeParticipant(participantPath, owner.token);
    throw error;
  }
}

/** Acquire one cross-process lock. Linux retains the kernel `flock` protocol
 * used by existing installations. Other systems use a Lamport bakery over
 * per-acquisition files: unique participant paths make stale cleanup immune to
 * the pathname replacement race of single-owner lock files. */
export async function acquireFileLock(path, suppliedOptions = {}) {
  const options = normalizedOptions(suppliedOptions);
  const owner = {
    schemaVersion: FILE_LOCK_VERSION,
    pid: process.pid,
    token: randomUUID(),
    processStartTime: await ownProcessStartIdentity(),
    createdAt: new Date().toISOString(),
  };
  return options.platform === "linux"
    ? acquireKernelLock(path, owner, options)
    : acquirePortableLock(path, owner, options);
}
