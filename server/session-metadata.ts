import { constants, type Dirent } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MAX_SESSION_ID_CHARS } from "../shared/contracts.js";
import { JsonlObjectDecoder, PersistedJsonlError } from "./session-jsonl.js";
import { getAgentDir } from "./pi-runtime.js";

const MAX_INDEXED_TEXT_CHARS = 10_000;
const MAX_SESSION_PATH_CHARS = 32_768;
const SESSION_READ_CONCURRENCY = 4;

class SessionMetadataFormatError extends Error {}

export interface SessionSourceIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface SessionRecord {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  searchText: string;
  /** Null only for a Pi-owned path that has not entered the catalog yet. */
  source: SessionSourceIdentity | null;
}

interface SessionMetadataState {
  header: {
    id: string;
    cwd: string;
    parentSessionPath?: string;
    timestamp: number | null;
    fallbackCreated: number;
  } | null;
  name?: string;
  firstMessage: string;
  messageCount: number;
  lastActivity: number | null;
}

interface CachedSessionRecord {
  version: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  completeBytes: number;
  state: SessionMetadataState | null;
  record: SessionRecord | null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8_640_000_000_000_000
    ? parsed
    : null;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string")
    return content.slice(0, MAX_INDEXED_TEXT_CHARS);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const value of content) {
    const block = recordValue(value);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const separator = text ? " " : "";
    const remaining = MAX_INDEXED_TEXT_CHARS - text.length;
    if (remaining <= 0) break;
    text += `${separator}${block.text}`.slice(0, remaining);
  }
  return text;
}

function emptyState(): SessionMetadataState {
  return {
    header: null,
    firstMessage: "",
    messageCount: 0,
    lastActivity: null,
  };
}

function copyState(state: SessionMetadataState): SessionMetadataState {
  return {
    ...state,
    header: state.header ? { ...state.header } : null,
  };
}

function applyEntry(
  state: SessionMetadataState,
  entry: Record<string, unknown>,
  fallbackModified: number,
): void {
  if (!state.header) {
    if (entry.type !== "session")
      throw new SessionMetadataFormatError(
        "Persisted session does not begin with a session header",
      );
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > MAX_SESSION_ID_CHARS
    )
      throw new SessionMetadataFormatError(
        "Persisted session has an invalid session identity",
      );
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    if (
      !cwd ||
      !isAbsolute(cwd) ||
      cwd.includes("\0") ||
      cwd.length > MAX_SESSION_PATH_CHARS
    ) {
      throw new SessionMetadataFormatError(
        "Persisted session has an invalid working directory",
      );
    }
    if (
      typeof entry.parentSession === "string" &&
      (!isAbsolute(entry.parentSession) ||
        entry.parentSession.includes("\0") ||
        entry.parentSession.length > MAX_SESSION_PATH_CHARS)
    ) {
      throw new SessionMetadataFormatError(
        "Persisted session has an invalid parent path",
      );
    }
    const parentSessionPath =
      typeof entry.parentSession === "string" ? entry.parentSession : undefined;
    state.header = {
      id: entry.id,
      cwd,
      ...(parentSessionPath ? { parentSessionPath } : {}),
      timestamp: timestamp(entry.timestamp),
      fallbackCreated: fallbackModified,
    };
    return;
  }
  if (entry.type === "session") {
    throw new SessionMetadataFormatError(
      "Persisted session contains a second session header",
    );
  }
  if (entry.type === "session_info") {
    state.name =
      typeof entry.name === "string"
        ? entry.name.trim().slice(0, MAX_INDEXED_TEXT_CHARS) || undefined
        : undefined;
    return;
  }
  if (entry.type !== "message") return;
  state.messageCount += 1;
  const message = recordValue(entry.message);
  if (!message) return;
  if (message.role !== "user" && message.role !== "assistant") return;
  const activity = timestamp(message.timestamp) ?? timestamp(entry.timestamp);
  if (activity !== null)
    state.lastActivity = Math.max(state.lastActivity ?? activity, activity);
  if (!state.firstMessage && message.role === "user") {
    const text = messageText(message);
    if (text.trim()) state.firstMessage = text;
  }
}

function projectRecord(
  path: string,
  state: SessionMetadataState,
  fallbackModified: number,
): Omit<SessionRecord, "source"> | null {
  const header = state.header;
  if (!header) return null;
  const createdTime = header.timestamp ?? header.fallbackCreated;
  return {
    path,
    id: header.id,
    cwd: header.cwd,
    ...(state.name ? { name: state.name } : {}),
    ...(header.parentSessionPath
      ? { parentSessionPath: header.parentSessionPath }
      : {}),
    created: new Date(createdTime),
    modified: new Date(
      state.lastActivity ?? header.timestamp ?? fallbackModified,
    ),
    messageCount: state.messageCount,
    firstMessage: state.firstMessage,
    searchText: [state.name, state.firstMessage, header.cwd]
      .filter(Boolean)
      .join("\n")
      .toLowerCase(),
  };
}

async function scanSessionFile(
  handle: FileHandle,
  path: string,
  size: number,
  start: number,
  previous: SessionMetadataState | null,
  fallbackModified: number,
): Promise<{
  state: SessionMetadataState;
  record: Omit<SessionRecord, "source"> | null;
  completeBytes: number;
}> {
  const state = previous ? copyState(previous) : emptyState();
  if (size === start)
    return {
      state,
      record: projectRecord(path, state, fallbackModified),
      completeBytes: start,
    };

  let framedBytes = 0;
  const decoder = new JsonlObjectDecoder((frame) => {
    framedBytes += frame.length;
  });
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - start));
  let offset = start;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    for (const entry of decoder.push(buffer.subarray(0, bytesRead)))
      applyEntry(state, entry, fallbackModified);
    offset += bytesRead;
  }
  return {
    state,
    record: projectRecord(path, state, fallbackModified),
    completeBytes: start + framedBytes,
  };
}

function stableMetadataError(error: unknown): boolean {
  return (
    error instanceof PersistedJsonlError ||
    error instanceof SessionMetadataFormatError
  );
}

const DISAPPEARED_PATH_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR"]);

function isDisappearedPath(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      DISAPPEARED_PATH_CODES.has(String((error as NodeJS.ErrnoException).code)),
  );
}

function sourceIdentity(details: SessionSourceIdentity): SessionSourceIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

function fileVersion(details: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}:${details.ctimeNs}`;
}

async function pathAddressesVersion(
  path: string,
  canonicalPath: string,
  version: string,
): Promise<boolean> {
  try {
    const [canonical, details] = await Promise.all([
      realpath(path),
      lstat(path, { bigint: true }),
    ]);
    return (
      canonical === canonicalPath &&
      details.isFile() &&
      fileVersion(details) === version
    );
  } catch (error) {
    if (isDisappearedPath(error)) return false;
    throw error;
  }
}

async function sessionFiles(root: string, nested: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!nested)
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(root, entry.name));
  const files: string[] = [];
  for (const entry of entries) {
    // Catalog authority does not follow links supplied inside Pi's storage
    // tree. Otherwise a linked directory or JSONL could promote an unrelated
    // file into open/delete operations.
    if (!entry.isDirectory()) continue;
    // A concurrently removed project contributes no sessions. Other read
    // failures abort the scan rather than publishing a partial catalog that
    // could make still-present sessions look deleted.
    files.push(...(await sessionFiles(join(root, entry.name), false)));
  }
  return files;
}

/** Rebuildable, stat-keyed metadata for Pi's JSONL session authority. */
export class SessionMetadataIndex {
  private readonly cache = new Map<string, CachedSessionRecord>();

  async list(customSessionDir?: string): Promise<SessionRecord[]> {
    const configuredRoot = resolve(
      customSessionDir ?? join(getAgentDir(), "sessions"),
    );
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(configuredRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = await sessionFiles(
      configuredRoot,
      customSessionDir === undefined,
    );
    const present = new Set(files);
    for (const path of this.cache.keys()) {
      if (!present.has(path)) this.cache.delete(path);
    }

    const records: Array<SessionRecord | null> = new Array(files.length).fill(
      null,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const index = next++;
        const path = files[index];
        if (path) {
          records[index] = await this.read(
            path,
            resolve(canonicalRoot, relative(configuredRoot, path)),
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SESSION_READ_CONCURRENCY, files.length) },
        worker,
      ),
    );
    return records.filter((record): record is SessionRecord => record !== null);
  }

  private async read(
    path: string,
    canonicalPath: string,
  ): Promise<SessionRecord | null> {
    const previous = this.cache.get(path);
    let authorityMismatch = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        try {
          const [openedPath, before] = await Promise.all([
            realpath(`/proc/self/fd/${handle.fd}`),
            handle.stat({ bigint: true }),
          ]);
          if (openedPath !== canonicalPath || !before.isFile()) {
            authorityMismatch = true;
            continue;
          }
          const version = fileVersion(before);
          const cached = this.cache.get(path);
          if (cached?.version === version) {
            if (await pathAddressesVersion(path, canonicalPath, version))
              return cached.record;
            continue;
          }
          if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
            return previous?.record ?? null;

          const append =
            cached !== undefined &&
            cached.state !== null &&
            cached.dev === before.dev &&
            cached.ino === before.ino &&
            cached.size < before.size &&
            cached.completeBytes <= Number(cached.size);
          const fallbackModified = Number(before.mtimeNs / 1_000_000n);
          let scan: Awaited<ReturnType<typeof scanSessionFile>> | null = null;
          let scanError: unknown;
          try {
            scan = await scanSessionFile(
              handle,
              path,
              Number(before.size),
              append ? cached.completeBytes : 0,
              append ? cached.state : null,
              fallbackModified,
            );
          } catch (error) {
            scanError = error;
            if (append) {
              try {
                scan = await scanSessionFile(
                  handle,
                  path,
                  Number(before.size),
                  0,
                  null,
                  fallbackModified,
                );
              } catch (fallbackError) {
                scanError = fallbackError;
              }
            }
          }
          const after = await handle.stat({ bigint: true });
          if (
            version !== fileVersion(after) ||
            !(await pathAddressesVersion(path, canonicalPath, version))
          )
            continue;
          if (!scan) {
            if (stableMetadataError(scanError)) {
              this.cache.set(path, {
                version,
                dev: before.dev,
                ino: before.ino,
                size: before.size,
                completeBytes: 0,
                state: null,
                record: previous?.record ?? null,
              });
            } else {
              throw scanError;
            }
            return previous?.record ?? null;
          }
          const record = scan.record
            ? { ...scan.record, source: sourceIdentity(before) }
            : null;
          this.cache.set(path, {
            version,
            dev: before.dev,
            ino: before.ino,
            size: before.size,
            completeBytes: scan.completeBytes,
            state: scan.state,
            record,
          });
          return record;
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      // A pathname that disappeared or became a symlink after enumeration may
      // retain its last complete UI record; every operation consuming it
      // revalidates the path and source identity. Read failures on a still
      // addressed regular file abort the scan so an incomplete catalog can
      // never authorize a reviewed batch operation.
      if (!isDisappearedPath(error)) throw error;
    }
    if (authorityMismatch) {
      this.cache.delete(path);
      return null;
    }
    return previous?.record ?? null;
  }
}
