import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { JsonlObjectDecoder } from "./session-jsonl.js";
import { getAgentDir } from "./pi-runtime.js";

const MAX_INDEXED_TEXT_CHARS = 10_000;
const MAX_SESSION_PATH_CHARS = 32_768;
const MAX_SESSION_ID_CHARS = 128;
const SESSION_READ_CONCURRENCY = 4;

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
      throw new Error("Persisted session does not begin with a session header");
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > MAX_SESSION_ID_CHARS
    )
      throw new Error("Persisted session has an invalid session identity");
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    if (cwd.length > MAX_SESSION_PATH_CHARS)
      throw new Error("Persisted session working directory is too long");
    const parentSessionPath =
      typeof entry.parentSession === "string" &&
      entry.parentSession.length <= MAX_SESSION_PATH_CHARS
        ? entry.parentSession
        : undefined;
    state.header = {
      id: entry.id,
      cwd,
      ...(parentSessionPath ? { parentSessionPath } : {}),
      timestamp: timestamp(entry.timestamp),
      fallbackCreated: fallbackModified,
    };
    return;
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
): SessionRecord | null {
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
  path: string,
  size: number,
  start: number,
  previous: SessionMetadataState | null,
  fallbackModified: number,
): Promise<{
  state: SessionMetadataState;
  record: SessionRecord | null;
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
  const input = createReadStream(path, { start, end: size - 1 });
  for await (const chunk of input) {
    for (const entry of decoder.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ))
      applyEntry(state, entry, fallbackModified);
  }
  return {
    state,
    record: projectRecord(path, state, fallbackModified),
    completeBytes: start + framedBytes,
  };
}

function stableMetadataError(error: unknown): boolean {
  return !(error && typeof error === "object" && "code" in error);
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

async function sessionFiles(root: string, nested: boolean): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (!nested)
      return entries
        .filter((entry) => entry.name.endsWith(".jsonl"))
        .map((entry) => join(root, entry.name));
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      files.push(...(await sessionFiles(join(root, entry.name), false)));
    }
    return files;
  } catch {
    return [];
  }
}

/** Rebuildable, stat-keyed metadata for Pi's JSONL session authority. */
export class SessionMetadataIndex {
  private readonly cache = new Map<string, CachedSessionRecord>();

  async list(customSessionDir?: string): Promise<SessionRecord[]> {
    const files = await sessionFiles(
      customSessionDir ?? join(getAgentDir(), "sessions"),
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
        if (path) records[index] = await this.read(path);
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

  private async read(path: string): Promise<SessionRecord | null> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await stat(path, { bigint: true });
        const version = fileVersion(before);
        const cached = this.cache.get(path);
        if (cached?.version === version) return cached.record;
        if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;

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
        const after = await stat(path, { bigint: true });
        if (version !== fileVersion(after)) continue;
        if (!scan) {
          if (stableMetadataError(scanError)) {
            this.cache.set(path, {
              version,
              dev: before.dev,
              ino: before.ino,
              size: before.size,
              completeBytes: 0,
              state: null,
              record: null,
            });
          } else {
            this.cache.delete(path);
          }
          return null;
        }
        this.cache.set(path, {
          version,
          dev: before.dev,
          ino: before.ino,
          size: before.size,
          completeBytes: scan.completeBytes,
          state: scan.state,
          record: scan.record,
        });
        return scan.record;
      }
    } catch {
      this.cache.delete(path);
    }
    return null;
  }
}
