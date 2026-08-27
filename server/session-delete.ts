import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { SessionDeleteDisposition } from "../shared/contracts.js";
import { moveToDesktopTrash } from "./desktop-trash.js";
import type { SessionRecord } from "./session-catalog.js";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;

interface SessionFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface QuarantinedSession {
  directory: string;
  path: string;
  identity: SessionFileIdentity;
}

function fileIdentity(stats: BigIntStats): SessionFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileVersion(
  left: SessionFileIdentity,
  right: SessionFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileObject(
  left: SessionFileIdentity,
  right: SessionFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** An authorized rename updates ctime even though the payload bytes did not
 * change, so the quarantine commit compares the remaining version fields. */
function sameRenamedFileVersion(
  left: SessionFileIdentity,
  right: SessionFileIdentity,
): boolean {
  return (
    sameFileObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

/** The payload has already left the public session pathname. `originalPath`
 * exists only to populate the desktop Trash restore metadata. */
type TrashSessionPath = (
  payloadPath: string,
  originalPath: string,
) => Promise<void>;
export type DeleteSessionRecord = (
  session: SessionRecord,
) => Promise<SessionDeleteDisposition>;

async function readFirstLine(handle: FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  while (length < MAX_SESSION_HEADER_BYTES) {
    const buffer = Buffer.alloc(
      Math.min(4_096, MAX_SESSION_HEADER_BYTES - length),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
    length += bytesRead;
  }
  throw Object.assign(new Error("The session header is missing or too large"), {
    status: 409,
  });
}

async function inspectSessionFile(
  session: SessionRecord,
): Promise<SessionFileIdentity> {
  const path = resolve(session.path);
  if (extname(path).toLowerCase() !== ".jsonl") {
    throw Object.assign(
      new Error("The catalog entry is not a Pi session file"),
      { status: 409 },
    );
  }

  const before = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw Object.assign(new Error("Session not found"), { status: 404 });
      throw error;
    },
  );
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(
      new Error("The catalog entry is not a regular session file"),
      { status: 409 },
    );
  }

  // O_NOFOLLOW closes the lstat/open symlink swap on the local Linux host.
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw Object.assign(new Error("Session not found"), { status: 404 });
    if (error.code === "ELOOP") {
      throw Object.assign(
        new Error("The catalog entry is not a regular session file"),
        { status: 409 },
      );
    }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    const openedIdentity = fileIdentity(opened);
    if (
      !opened.isFile() ||
      !sameFileVersion(openedIdentity, fileIdentity(before))
    ) {
      throw Object.assign(
        new Error("The session file changed while deletion was being prepared"),
        { status: 409 },
      );
    }
    const firstLine = await readFirstLine(handle);
    const afterRead = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw Object.assign(new Error("Session not found"), { status: 404 });
        throw error;
      },
    );
    const currentIdentity = fileIdentity(afterRead);
    if (
      !afterRead.isFile() ||
      !linked.isFile() ||
      !sameFileVersion(openedIdentity, currentIdentity) ||
      !sameFileVersion(currentIdentity, fileIdentity(linked))
    ) {
      throw Object.assign(
        new Error("The session file changed while deletion was being prepared"),
        { status: 409 },
      );
    }
    let header: unknown;
    try {
      header = JSON.parse(firstLine.replace(/\r$/, ""));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error("The session header is invalid"), {
          status: 409,
        });
      }
      throw error;
    }
    const record =
      header && typeof header === "object"
        ? (header as Record<string, unknown>)
        : null;
    if (record?.type !== "session" || record.id !== session.id) {
      throw Object.assign(
        new Error("The session file identity does not match the catalog"),
        { status: 409 },
      );
    }
    return currentIdentity;
  } finally {
    await handle.close();
  }
}

async function fileIdentityAt(
  path: string,
): Promise<SessionFileIdentity | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return fileIdentity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
}

type RemoveEmptyDirectory = (path: string) => Promise<void>;

async function cleanCommittedDirectory(
  path: string,
  removeDirectory: RemoveEmptyDirectory,
): Promise<void> {
  // Once the payload has moved to Trash or been unlinked, an empty-container
  // cleanup failure cannot roll the deletion back and must not make it look
  // retryable. A later cleanup may remove the private empty directory.
  await removeDirectory(path).catch(() => undefined);
}

async function quarantineSession(
  path: string,
  inspected: SessionFileIdentity,
): Promise<QuarantinedSession> {
  const directory = await mkdtemp(join(dirname(path), ".inspire-delete-"));
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
  const quarantine = {
    directory,
    path: join(directory, basename(path) || "session.jsonl"),
    identity: inspected,
  };
  try {
    await rename(path, quarantine.path);
  } catch (error) {
    await removeEmptyDirectory(directory);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(
        new Error("The session file changed while deletion was being prepared"),
        { status: 409 },
      );
    }
    throw error;
  }

  const moved = await fileIdentityAt(quarantine.path);
  if (!moved || !sameRenamedFileVersion(moved, inspected)) {
    // No automatic restore is safe here. A replacement at the private
    // pathname must never be promoted back into the public Pi catalog.
    if (!moved) await removeEmptyDirectory(directory);
    throw Object.assign(
      new Error("The session file changed while deletion was being prepared"),
      { status: 409 },
    );
  }
  quarantine.identity = moved;
  return quarantine;
}

async function permanentlyDeleteQuarantine(
  quarantine: QuarantinedSession,
  inspected: SessionFileIdentity,
  trashError: unknown,
  removeDirectory: RemoveEmptyDirectory,
): Promise<SessionDeleteDisposition> {
  const current = await fileIdentityAt(quarantine.path);
  // The Trash consumer may have moved the authorized inode before reporting
  // failure. An absent private entry therefore has a committed trash outcome.
  if (current === null) {
    await cleanCommittedDirectory(quarantine.directory, removeDirectory);
    return "trashed";
  }
  // Anything other than the exact post-quarantine version is indeterminate.
  // Leave it isolated: no unknown object may re-enter the public catalog or
  // become the fallback unlink target.
  if (!sameFileVersion(current, inspected)) {
    throw Object.assign(
      new Error(
        "The private session payload changed before permanent deletion and was preserved for recovery",
      ),
      { status: 409 },
    );
  }

  // The callback knew the quarantine pathname. Move the verified inode once
  // more into a newly private directory before unlinking. The destination
  // cannot clobber an existing file, and any replacement that wins the source
  // race is detected after the move and left there for recovery.
  const purgeDirectory = await mkdtemp(join(quarantine.directory, ".purge-"));
  await chmod(purgeDirectory, PRIVATE_DIRECTORY_MODE);
  const purgePath = join(purgeDirectory, "payload");
  try {
    await rename(quarantine.path, purgePath);
  } catch (error) {
    await removeEmptyDirectory(purgeDirectory);
    throw Object.assign(
      new Error(
        "The private session payload changed before permanent deletion and was preserved for recovery",
      ),
      { status: 409, cause: error },
    );
  }
  const purged = await fileIdentityAt(purgePath);
  if (!purged || !sameRenamedFileVersion(purged, inspected)) {
    throw Object.assign(
      new Error(
        "The private session payload changed before permanent deletion and was preserved for recovery",
      ),
      { status: 409 },
    );
  }

  try {
    await unlink(purgePath);
  } catch (error) {
    const failure = Object.assign(
      new Error("The session could not be deleted"),
      { status: 500 },
    );
    (failure as Error & { cause?: unknown }).cause = {
      trashError,
      unlinkError: error,
    };
    throw failure;
  }
  await cleanCommittedDirectory(purgeDirectory, removeDirectory);
  await cleanCommittedDirectory(quarantine.directory, removeDirectory);
  return "deleted";
}

/** Delete one catalog-authorized Pi session. The verified public directory
 * entry first moves to a private same-filesystem quarantine. Trash and fallback
 * deletion can then operate only on that identity-bound payload; the original
 * pathname is retained separately as desktop restore metadata. */
export async function deleteSessionFile(
  session: SessionRecord,
  moveToTrash: TrashSessionPath = moveToDesktopTrash,
  removeDirectory: RemoveEmptyDirectory = removeEmptyDirectory,
): Promise<SessionDeleteDisposition> {
  const path = resolve(session.path);
  const inspected = await inspectSessionFile(session);
  const quarantine = await quarantineSession(path, inspected);
  let trashError: unknown;
  try {
    await moveToTrash(quarantine.path, path);
  } catch (error) {
    trashError = error;
  }

  const current = await fileIdentityAt(quarantine.path);
  if (trashError === undefined) {
    if (current === null) {
      await cleanCommittedDirectory(quarantine.directory, removeDirectory);
      return "trashed";
    }
    if (!sameFileVersion(current, quarantine.identity)) {
      throw Object.assign(
        new Error(
          "The private session payload changed during Trash and was preserved for recovery",
        ),
        { status: 409 },
      );
    }
    // A nominally successful adapter that leaves the authorized payload in
    // quarantine has not committed deletion. Retain the payload privately
    // rather than racing a restoration through the old public pathname.
    throw Object.assign(
      new Error("The Trash operation did not move the session payload"),
      { status: 502 },
    );
  }
  return permanentlyDeleteQuarantine(
    quarantine,
    quarantine.identity,
    trashError,
    removeDirectory,
  );
}
