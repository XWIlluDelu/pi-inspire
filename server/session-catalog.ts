import { SettingsManager } from "./pi-runtime.js";
import {
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  MAX_SESSION_LIST_PAGE_SIZE,
  projectNameFromCwd,
  type SessionListResponse,
  type SessionSummary,
} from "../shared/contracts.js";
import {
  SessionMetadataIndex,
  type SessionRecord,
} from "./session-metadata.js";

export type { SessionRecord } from "./session-metadata.js";

const CACHE_MS = 5_000;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSessionRecords(a: SessionRecord, b: SessionRecord): number {
  return (
    b.modified.getTime() - a.modified.getTime() ||
    b.created.getTime() - a.created.getTime() ||
    compareText(a.id, b.id) ||
    compareText(a.path, b.path)
  );
}

export function orderSessionRecords(
  sessions: readonly SessionRecord[],
): SessionRecord[] {
  return [...sessions].sort(compareSessionRecords);
}

function displayTitle(session: SessionRecord): string {
  const candidate = session.name?.trim() || session.firstMessage.trim();
  return candidate
    ? candidate.replace(/\s+/g, " ").slice(0, MAX_SESSION_DISPLAY_TITLE_CHARS)
    : "New session";
}

/** The newest sessions of each named working directory, bounded per directory.
 * Selection is separate from projection so the ordering and the bound stay
 * checkable without a Pi session tree. */
export function newestPerCwd(
  sessions: readonly SessionRecord[],
  cwds: readonly string[],
  limitPerCwd: number,
): SessionRecord[] {
  const wanted = new Set(cwds);
  if (wanted.size === 0) return [];
  const matching = sessions.filter((session) => wanted.has(session.cwd));
  matching.sort(compareSessionRecords);
  const taken = new Map<string, number>();
  return matching.filter((session) => {
    const count = taken.get(session.cwd) ?? 0;
    if (count >= limitPerCwd) return false;
    taken.set(session.cwd, count + 1);
    return true;
  });
}

export interface SessionCatalogLike {
  refresh(force?: boolean): Promise<readonly SessionRecord[]>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(options?: {
    query?: string;
    offset?: number;
    limit?: number;
  }): Promise<SessionListResponse>;
  listByIds(ids: readonly string[]): Promise<SessionSummary[]>;
  listByCwds(
    cwds: readonly string[],
    limitPerCwd?: number,
  ): Promise<SessionSummary[]>;
  invalidate(): void;
}

export class SessionCatalog implements SessionCatalogLike {
  private cached: SessionRecord[] = [];
  private loadedAt = 0;
  private byId = new Map<string, SessionRecord>();
  private ambiguousIds = new Set<string>();
  private idByPath = new Map<string, string>();
  private generation = 0;
  private loadedGeneration = -1;
  private loading: {
    generation: number;
    promise: Promise<void>;
  } | null = null;

  constructor(
    private readonly startupCwd: string,
    private readonly metadata: Pick<
      SessionMetadataIndex,
      "list"
    > = new SessionMetadataIndex(),
  ) {}

  async refresh(force = false): Promise<readonly SessionRecord[]> {
    if (force) this.invalidate();

    for (;;) {
      const generation = this.generation;
      if (
        this.loadedGeneration === generation &&
        this.loadedAt > 0 &&
        Date.now() - this.loadedAt < CACHE_MS
      ) {
        return this.cached;
      }

      try {
        await this.loadGeneration(generation);
      } catch (error) {
        // An obsolete scan cannot decide the result of a caller that crossed
        // an invalidation boundary. The current generation owns that result.
        if (generation !== this.generation) continue;
        throw error;
      }
      if (this.loadedGeneration === this.generation) return this.cached;
    }
  }

  private loadGeneration(generation: number): Promise<void> {
    if (this.loading?.generation === generation) return this.loading.promise;

    const predecessor = this.loading?.promise;
    const loading = (async (): Promise<void> => {
      // Metadata enumeration can be expensive. Generations serialize scans,
      // while the checks on both sides keep obsolete results from publishing.
      if (predecessor) await predecessor.catch(() => undefined);
      if (generation !== this.generation) return;

      const sessionDir = SettingsManager.create(
        this.startupCwd,
      ).getSessionDir();
      const sessions = await this.metadata.list(sessionDir);
      if (generation !== this.generation) return;

      // Pi storage enumeration is not an ordering contract. Page boundaries
      // require one deterministic newest-first order with stable tie-breakers.
      const cached = orderSessionRecords(sessions);
      const byId = new Map<string, SessionRecord>();
      const ambiguousIds = new Set<string>();
      for (const session of cached) {
        if (ambiguousIds.has(session.id)) continue;
        if (byId.delete(session.id)) ambiguousIds.add(session.id);
        else byId.set(session.id, session);
      }
      const idByPath = new Map(
        cached
          .filter((session) => !ambiguousIds.has(session.id))
          .map((session) => [session.path, session.id]),
      );
      this.cached = cached;
      this.byId = byId;
      this.ambiguousIds = ambiguousIds;
      this.idByPath = idByPath;
      this.loadedAt = Date.now();
      this.loadedGeneration = generation;
    })();
    this.loading = { generation, promise: loading };
    const clear = () => {
      if (this.loading?.promise === loading) this.loading = null;
    };
    void loading.then(clear, clear);
    return loading;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    // Opening needs stable identity/path/cwd, not freshly sorted list metadata.
    // Keep known identities usable after invalidate() so a click never pays for
    // a global JSONL rescan; explicit/list refreshes still rebuild the catalog.
    if (
      (this.ambiguousIds.has(id) &&
        this.loadedGeneration !== this.generation) ||
      (!this.byId.has(id) && !this.ambiguousIds.has(id))
    ) {
      await this.refresh();
    }
    if (this.ambiguousIds.has(id)) {
      throw Object.assign(
        new Error("The session identity is ambiguous in the Pi catalog"),
        { status: 409 },
      );
    }
    return this.byId.get(id);
  }

  async list(
    options: { query?: string; offset?: number; limit?: number } = {},
  ): Promise<SessionListResponse> {
    const sessions = (await this.refresh()).filter(
      (session) => !this.ambiguousIds.has(session.id),
    );
    const query = options.query?.trim().toLowerCase().slice(0, 200) ?? "";
    const requestedOffset = Number.isFinite(options.offset)
      ? Math.floor(options.offset!)
      : 0;
    const requestedLimit = Number.isFinite(options.limit)
      ? Math.floor(options.limit!)
      : 40;
    const offset = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, requestedOffset),
    );
    const limit = Math.min(
      MAX_SESSION_LIST_PAGE_SIZE,
      Math.max(1, requestedLimit),
    );
    const filtered = query
      ? sessions.filter((session) => session.searchText.includes(query))
      : sessions;

    return {
      sessions: filtered
        .slice(offset, offset + limit)
        .map((session) => this.project(session)),
      total: filtered.length,
      offset,
      limit,
    };
  }

  async listByIds(ids: readonly string[]): Promise<SessionSummary[]> {
    await this.refresh();
    const sessions = await Promise.all(
      [...new Set(ids)].map((id) => this.get(id)),
    );
    return sessions.flatMap((session) =>
      session ? [this.project(session)] : [],
    );
  }

  /** The newest sessions of each named working directory. A folder pinned as
   * a whole is a complete navigation section, so it cannot depend on which of
   * its sessions happen to fall inside the first chronological page. */
  async listByCwds(
    cwds: readonly string[],
    limitPerCwd = 40,
  ): Promise<SessionSummary[]> {
    if (cwds.length === 0) return [];
    return newestPerCwd(
      (await this.refresh()).filter(
        (session) => !this.ambiguousIds.has(session.id),
      ),
      cwds,
      limitPerCwd,
    ).map((session) => this.project(session));
  }

  project(session: SessionRecord): SessionSummary {
    const parentSessionId = session.parentSessionPath
      ? this.idByPath.get(session.parentSessionPath)
      : undefined;
    return {
      id: session.id,
      cwd: session.cwd,
      project: projectNameFromCwd(session.cwd),
      title: displayTitle(session),
      created: session.created.toISOString(),
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }

  invalidate(): void {
    this.generation += 1;
    this.loadedAt = 0;
  }
}
