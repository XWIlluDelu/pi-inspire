import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionDeleteDisposition } from "../shared/contracts.js";
import type { SessionRecord } from "./session-catalog.js";

const execFileAsync = promisify(execFile);
const MAX_SESSION_HEADER_BYTES = 64 * 1024;

interface SessionFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
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

function sameFileVersion(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

// A same-filesystem rename updates ctime on common filesystems. Preserve the
// authoritative inode, content length, and mtime checks while allowing that
// one expected directory-entry transition; later checks use the post-rename
// identity and are strict again.
function sameFileAfterRename(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

export type TrashSessionPath = (path: string) => Promise<void>;
export type DeleteSessionRecord = (session: SessionRecord) => Promise<SessionDeleteDisposition>;

async function readFirstLine(handle: FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  while (length < MAX_SESSION_HEADER_BYTES) {
    const buffer = Buffer.alloc(Math.min(4_096, MAX_SESSION_HEADER_BYTES - length));
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
  throw Object.assign(new Error("The session header is missing or too large"), { status: 409 });
}

async function inspectSessionFile(session: SessionRecord): Promise<SessionFileIdentity> {
  const path = resolve(session.path);
  if (extname(path).toLowerCase() !== ".jsonl") {
    throw Object.assign(new Error("The catalog entry is not a Pi session file"), { status: 409 });
  }

  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("Session not found"), { status: 404 });
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error("The catalog entry is not a regular session file"), { status: 409 });
  }

  // O_NOFOLLOW closes the lstat/open symlink swap on the local Linux host.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("Session not found"), { status: 404 });
    if (error.code === "ELOOP") {
      throw Object.assign(new Error("The catalog entry is not a regular session file"), { status: 409 });
    }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    const openedIdentity = fileIdentity(opened);
    if (!opened.isFile() || !sameFileVersion(openedIdentity, fileIdentity(before))) {
      throw Object.assign(new Error("The session file changed while deletion was being prepared"), { status: 409 });
    }
    const firstLine = await readFirstLine(handle);
    const afterRead = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw Object.assign(new Error("Session not found"), { status: 404 });
      throw error;
    });
    const currentIdentity = fileIdentity(afterRead);
    if (
      !afterRead.isFile() || !linked.isFile() ||
      !sameFileVersion(openedIdentity, currentIdentity) ||
      !sameFileVersion(currentIdentity, fileIdentity(linked))
    ) {
      throw Object.assign(new Error("The session file changed while deletion was being prepared"), { status: 409 });
    }
    let header: unknown;
    try {
      header = JSON.parse(firstLine.replace(/\r$/, ""));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error("The session header is invalid"), { status: 409 });
      }
      throw error;
    }
    const record = header && typeof header === "object" ? header as Record<string, unknown> : null;
    if (record?.type !== "session" || record.id !== session.id) {
      throw Object.assign(new Error("The session file identity does not match the catalog"), { status: 409 });
    }
    return currentIdentity;
  } finally {
    await handle.close();
  }
}

async function trashPath(path: string): Promise<void> {
  await execFileAsync("trash", [path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileIdentityAt(path: string): Promise<SessionFileIdentity | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return fileIdentity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exactFileAt(path: string, expected: SessionFileIdentity): Promise<boolean> {
  const identity = await fileIdentityAt(path);
  return identity !== null && sameFileVersion(identity, expected);
}

/** Move the inspected public directory entry to a fresh hidden sibling. The
 * random name prevents an ordinary path collision; the identity check below
 * is still authoritative before any path-based destructive operation. */
async function quarantineSessionFile(
  path: string,
  expected: SessionFileIdentity,
): Promise<{ path: string; identity: SessionFileIdentity }> {
  const name = basename(path);
  const directory = dirname(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quarantine = join(directory, `.${name}.inspire-delete-${randomUUID()}`);
    if (await pathExists(quarantine)) continue;
    try {
      await rename(path, quarantine);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code === "ENOENT") throw Object.assign(new Error("Session not found"), { status: 404 });
      throw error;
    }
    const moved = await fileIdentityAt(quarantine);
    if (moved && sameFileAfterRename(moved, expected)) return { path: quarantine, identity: moved };
    throw Object.assign(new Error("The session file changed while deletion was being prepared"), { status: 409 });
  }
  throw Object.assign(new Error("The session deletion quarantine could not be reserved"), { status: 409 });
}

/** Delete one catalog-authorized Pi session. This mirrors Pi's own picker:
 * atomically quarantine the validated entry, prefer the desktop Trash, then
 * permanently unlink only after revalidating that quarantine still names the
 * exact inspected session inode. */
export async function deleteSessionFile(
  session: SessionRecord,
  moveToTrash: TrashSessionPath = trashPath,
): Promise<SessionDeleteDisposition> {
  const path = resolve(session.path);
  const identity = await inspectSessionFile(session);
  const quarantined = await quarantineSessionFile(path, identity);
  const quarantine = quarantined.path;
  let trashError: unknown;
  try {
    await moveToTrash(quarantine);
  } catch (error) {
    trashError = error;
  }
  if (trashError === undefined) {
    if (await pathExists(quarantine)) {
      throw Object.assign(new Error("The Trash command did not remove the session file"), { status: 502 });
    }
    return "trashed";
  }

  // A command can move the quarantined file and still report failure. The
  // destructive result is already known in that case; never retry it as a
  // permanent unlink operation.
  if (!(await pathExists(quarantine))) return "trashed";

  if (!(await exactFileAt(quarantine, quarantined.identity))) {
    throw Object.assign(new Error("The session file changed before permanent deletion"), { status: 409 });
  }
  try {
    await unlink(quarantine);
    return "deleted";
  } catch (error) {
    const failure = Object.assign(new Error("The session could not be deleted"), { status: 500 });
    (failure as Error & { cause?: unknown }).cause = { trashError, unlinkError: error };
    throw failure;
  }
}
