import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import type { SessionCatalogIssue } from "../shared/contracts.js";
import { stripImageDimensionNotes } from "../shared/image-dimension-notes.js";
import { jsonRecord } from "../shared/json-record.js";
import { userMessageTitle } from "../shared/user-message.js";
import {
  isDisappearedSessionPath,
  PersistedJsonlError,
  SessionDocumentReader,
  type SessionSourceIdentity,
  SessionSourceTypeError,
  sameSessionObject,
  sessionSourceVersion,
} from "./session-jsonl.js";
import {
  sessionSearchMatcher,
  sessionSearchSnippet,
} from "./session-search-query.js";

const MAX_INDEXED_TEXT_CHARS = 10_000;
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

function searchMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const imageCount = content.filter(
    (value) => jsonRecord(value)?.type === "image",
  ).length;
  return content
    .flatMap((value) => {
      const block = jsonRecord(value);
      return block?.type === "text" && typeof block.text === "string"
        ? [stripImageDimensionNotes(block.text, imageCount)]
        : [];
    })
    .join(" ");
}

function emptyState(): SessionMetadataState {
  return {
    header: null,
    firstMessage: "",
    messageCount: 0,
    lastActivity: null,
  };
}

function applyEntry(
  state: SessionMetadataState,
  entry: Record<string, unknown>,
  header: SessionHeader | null,
  fallbackModified: number,
): void {
  if (header) {
    state.header = {
      id: header.id,
      cwd: header.cwd,
      ...(header.parentSession
        ? { parentSessionPath: header.parentSession }
        : {}),
      timestamp: timestamp(header.timestamp),
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
  const message = jsonRecord(entry.message);
  if (!message) return;
  if (message.role !== "user" && message.role !== "assistant") return;
  const activity = timestamp(message.timestamp) ?? timestamp(entry.timestamp);
  if (activity !== null)
    state.lastActivity = Math.max(state.lastActivity ?? activity, activity);
  if (!state.firstMessage && message.role === "user") {
    state.firstMessage = userMessageTitle(message.content);
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
  };
}

async function scanSessionFile(
  document: SessionDocumentReader,
  path: string,
  start: number,
  previous: SessionMetadataState | null,
  onEntry?: (entry: Record<string, unknown>) => void,
): Promise<{
  state: SessionMetadataState;
  record: Omit<SessionRecord, "source"> | null;
  completeBytes: number;
}> {
  const state = previous ? { ...previous } : emptyState();
  const fallbackModified = Number(document.source.mtimeNs / 1_000_000n);
  const scan = await document.scan(start, (entry, header) => {
    applyEntry(state, entry, header, fallbackModified);
    onEntry?.(entry);
  });
  return {
    state,
    record: projectRecord(path, state, fallbackModified),
    completeBytes: scan.completeBytes,
  };
}

function readFailure(
  issues: SessionCatalogIssue[] | undefined,
  path: string,
  error: unknown,
): void {
  if (!issues) throw error;
  issues.push({
    path,
    message:
      error instanceof Error ? error.message : "Session source is unavailable",
  });
}

async function sessionFiles(
  root: string,
  nested: boolean,
  issues?: SessionCatalogIssue[],
): Promise<string[]> {
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
    const path = join(root, entry.name);
    try {
      files.push(...(await sessionFiles(path, false, issues)));
    } catch (error) {
      readFailure(issues, path, error);
    }
  }
  return files;
}

/** Rebuildable, stat-keyed metadata for Pi's JSONL session authority. */
export class SessionMetadataIndex {
  private readonly cache = new Map<string, CachedSessionRecord>();

  /** Refresh one already-discovered identity without enumerating storage or
   * materializing its transcript. Dormant native sessions use this for titles. */
  async readCurrent(session: SessionRecord): Promise<SessionRecord | null> {
    const current = await this.read(session.path, await realpath(session.path));
    if (
      !current ||
      current.id !== session.id ||
      current.cwd !== session.cwd ||
      (session.source &&
        (!current.source ||
          current.source.dev !== session.source.dev ||
          current.source.ino !== session.source.ino))
    )
      return null;
    return current;
  }

  async list(
    directories: string | readonly (string | undefined)[] = [undefined],
    issues?: SessionCatalogIssue[],
  ): Promise<SessionRecord[]> {
    const roots = typeof directories === "string" ? [directories] : directories;
    const pathsByCanonical = new Map<string, string>();
    // Browse healthy roots independently. Callers requiring a complete set can
    // omit the issue collector or reject an incomplete result at their own boundary.
    const failedRoots: string[] = [];
    for (const customSessionDir of new Set(roots)) {
      const configuredRoot = resolve(
        customSessionDir ??
          join((await import("./pi-runtime.js")).getAgentDir(), "sessions"),
      );
      let canonicalRoot: string;
      let files: string[];
      const issuesBefore = issues?.length ?? 0;
      try {
        canonicalRoot = await realpath(configuredRoot);
        files = await sessionFiles(
          configuredRoot,
          customSessionDir === undefined,
          issues,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        readFailure(issues, configuredRoot, error);
        failedRoots.push(configuredRoot);
        continue;
      }
      failedRoots.push(
        ...(issues?.slice(issuesBefore).map((issue) => issue.path) ?? []),
      );
      for (const path of files) {
        const canonical = resolve(
          canonicalRoot,
          relative(configuredRoot, path),
        );
        // Overlapping roots (or root aliases) describe one file, not duplicate
        // Pi identities. Links within storage remain excluded by sessionFiles.
        if (!pathsByCanonical.has(canonical))
          pathsByCanonical.set(canonical, path);
      }
    }
    const files = [...pathsByCanonical].map(([canonical, path]) => ({
      canonical,
      path,
    }));
    const present = new Set(pathsByCanonical.values());
    const retained: SessionRecord[] = [];
    for (const [path, cached] of this.cache) {
      if (present.has(path)) continue;
      const unavailable = failedRoots.some((root) => {
        const child = relative(root, path);
        return (
          !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
        );
      });
      if (unavailable) {
        if (cached.record) retained.push(cached.record);
      } else this.cache.delete(path);
    }

    const records: Array<SessionRecord | null> = new Array(files.length).fill(
      null,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const index = next++;
        const file = files[index]!;
        try {
          records[index] = await this.read(file.path, file.canonical);
        } catch (error) {
          readFailure(issues, file.path, error);
          records[index] = this.cache.get(file.path)?.record ?? null;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SESSION_READ_CONCURRENCY, files.length) },
        worker,
      ),
    );
    return [
      ...records.filter((record): record is SessionRecord => record !== null),
      ...retained,
    ];
  }

  /** Worker-only scan: one complete session at a time, never cached. */
  async scanSearch(
    sessions: readonly SessionRecord[],
    query: string,
    issues?: SessionCatalogIssue[],
    snippets?: Map<string, string>,
  ): Promise<SessionRecord[]> {
    const matchesQuery = sessionSearchMatcher(query);
    const matches: SessionRecord[] = [];
    for (const session of sessions) {
      let document: SessionDocumentReader | undefined;
      try {
        document = await SessionDocumentReader.open(session.path);
        const canonical = await realpath(session.path);
        if (
          !session.source ||
          !sameSessionObject(session.source, document.source) ||
          !(await document.stillAddressesPrefix(canonical))
        ) {
          throw new Error("Session source changed; refresh the session list");
        }
        let name: string | undefined;
        const messages: string[] = [];
        const scan = await scanSessionFile(
          document,
          session.path,
          0,
          null,
          (entry) => {
            if (entry.type === "session_info")
              name =
                typeof entry.name === "string"
                  ? entry.name.trim() || undefined
                  : undefined;
            if (entry.type !== "message") return;
            const message = jsonRecord(entry.message);
            if (message?.role !== "user" && message?.role !== "assistant")
              return;
            const text = searchMessageText(message);
            if (text) messages.push(text);
          },
        );
        if (
          scan.record?.id !== session.id ||
          scan.record.cwd !== session.cwd ||
          !(await document.stillAddressesPrefix(canonical))
        ) {
          throw new Error("Session source changed while searching; try again");
        }
        const allMessagesText = messages.join(" ");
        if (
          matchesQuery({
            id: session.id,
            cwd: session.cwd,
            name,
            allMessagesText,
          })
        ) {
          matches.push(session);
          const snippet = snippets
            ? sessionSearchSnippet(query, allMessagesText)
            : undefined;
          if (snippet) snippets?.set(session.id, snippet);
        }
      } catch (error) {
        readFailure(issues, session.path, error);
      } finally {
        await document?.close();
      }
    }
    return matches;
  }

  private async read(
    path: string,
    canonicalPath: string,
  ): Promise<SessionRecord | null> {
    const previous = this.cache.get(path);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const document = await SessionDocumentReader.open(path);
        try {
          const before = document.source;
          const version = sessionSourceVersion(before);
          const cached = this.cache.get(path);
          if (cached?.version === version) {
            if (await document.addressesVersion(canonicalPath))
              return cached.record;
            continue;
          }
          if (!(await document.addressesVersion(canonicalPath))) continue;
          const append =
            cached !== undefined &&
            cached.state !== null &&
            sameSessionObject(cached, before) &&
            cached.size < before.size &&
            cached.completeBytes <= Number(cached.size);
          let scan: Awaited<ReturnType<typeof scanSessionFile>> | null = null;
          let scanError: unknown;
          try {
            scan = await scanSessionFile(
              document,
              path,
              append ? cached.completeBytes : 0,
              append ? cached.state : null,
            );
          } catch (error) {
            scanError = error;
            if (append) {
              try {
                scan = await scanSessionFile(document, path, 0, null);
              } catch (fallbackError) {
                scanError = fallbackError;
              }
            }
          }
          if (!(await document.stillCurrent(canonicalPath))) continue;
          if (!scan) {
            if (scanError instanceof PersistedJsonlError) {
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
            ? { ...scan.record, source: before }
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
          await document.close();
        }
      }
    } catch (error) {
      // A pathname that disappeared or became a symlink after enumeration may
      // retain its last complete UI record; every operation consuming it
      // revalidates the path and source identity. Read failures on a still
      // addressed regular file are reported to the scan caller. Browsing can
      // retain this summary; destructive callers still require a complete set.
      if (error instanceof SessionSourceTypeError) {
        this.cache.delete(path);
        return null;
      }
      if (!isDisappearedSessionPath(error)) throw error;
    }
    return previous?.record ?? null;
  }
}
