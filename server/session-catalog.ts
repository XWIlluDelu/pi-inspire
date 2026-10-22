import {
  MAX_CURATED_SESSION_RESULTS,
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  MAX_SESSION_LIST_PAGE_SIZE,
  projectNameFromCwd,
  type SessionCatalogIssue,
  type SessionListResponse,
  type SessionSummary,
} from "../shared/contracts.js";
import { resolvePiSessionDirectory } from "./pi-session-directory.js";
import type { PreferencesStore } from "./preferences.js";
import type { ProjectDirectoryStore } from "./project-directories.js";
import { requestError } from "./request-error.js";
import {
  SessionMetadataIndex,
  type SessionRecord,
} from "./session-metadata.js";

import { searchSessionRecords } from "./session-search.js";

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
  refresh(
    force?: boolean,
    options?: { requireComplete?: boolean },
  ): Promise<readonly SessionRecord[]>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(options?: {
    query?: string;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SessionListResponse>;
  listByIds(ids: readonly string[]): Promise<SessionSummary[]>;
  listByCwds(cwds: readonly string[]): Promise<SessionSummary[]>;
  invalidate(): void;
  /** Retain discovery hints in memory before attempting optional persistence. */
  rememberProjectCwds?(cwds: readonly string[]): Promise<void>;
  /** Complete configured storage roots, independent of curation/pagination. */
  sessionDirectories?(): Promise<readonly (string | undefined)[]>;
}

export class SessionCatalog implements SessionCatalogLike {
  private cached: SessionRecord[] = [];
  private observedProjectCwds = new Set<string>();
  private issues: SessionCatalogIssue[] = [];
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
    private readonly projectCwds: () => Promise<
      readonly string[]
    > = async () => [],
    private readonly projects?: ProjectDirectoryStore,
  ) {}

  async rememberProjectCwds(cwds: readonly string[]): Promise<void> {
    for (const cwd of cwds) this.observedProjectCwds.add(cwd);
    this.invalidate();
    await this.projects?.remember([...this.observedProjectCwds]);
  }

  async refresh(
    force = false,
    options: { requireComplete?: boolean } = {},
  ): Promise<readonly SessionRecord[]> {
    await this.refreshRecords(force);
    if (options.requireComplete) this.requireComplete();
    return this.cached;
  }

  private requireComplete(): void {
    if (this.issues.length)
      throw requestError(
        "The session catalog is incomplete because some sources are unavailable. Restore access and refresh the session list.",
        409,
        { code: "SESSION_CATALOG_INCOMPLETE" },
      );
  }

  private async refreshRecords(force: boolean): Promise<void> {
    if (force) this.invalidate();

    for (;;) {
      const generation = this.generation;
      if (
        this.loadedGeneration === generation &&
        this.loadedAt > 0 &&
        Date.now() - this.loadedAt < CACHE_MS
      ) {
        return;
      }

      try {
        await this.loadGeneration(generation);
      } catch (error) {
        // An obsolete scan cannot decide the result of a caller that crossed
        // an invalidation boundary. The current generation owns that result.
        if (generation !== this.generation) continue;
        throw error;
      }
      if (this.loadedGeneration === this.generation) return;
    }
  }

  async sessionDirectories(
    issues?: SessionCatalogIssue[],
  ): Promise<readonly (string | undefined)[]> {
    const unavailable = (path: string, error: unknown) => {
      if (!issues) throw error;
      issues.push({
        path,
        message:
          error instanceof Error
            ? error.message
            : "Session discovery is unavailable",
      });
    };
    const seeds = [this.startupCwd, ...this.observedProjectCwds];
    try {
      seeds.push(...(await this.projectCwds()));
    } catch (error) {
      unavailable(this.startupCwd, error);
    }
    const cwds = new Set(seeds);
    try {
      for (const cwd of (await this.projects?.read()) ?? []) cwds.add(cwd);
    } catch (error) {
      unavailable(this.projects!.path, error);
    }
    // A refresh retries unsaved hints, including projects used while their
    // registry was unavailable. These writes never authorize a Pi writer.
    try {
      await this.projects?.remember(seeds);
    } catch (error) {
      console.warn("Project discovery hints could not be saved", error);
    }
    const directories = new Set<string | undefined>();
    for (const cwd of cwds) {
      try {
        directories.add(await resolvePiSessionDirectory(cwd));
      } catch (error) {
        unavailable(cwd, error);
      }
    }
    return [...directories];
  }

  private loadGeneration(generation: number): Promise<void> {
    if (this.loading?.generation === generation) return this.loading.promise;

    const predecessor = this.loading?.promise;
    const loading = (async (): Promise<void> => {
      // Metadata enumeration can be expensive. Generations serialize scans,
      // while the checks on both sides keep obsolete results from publishing.
      if (predecessor) await predecessor.catch(() => undefined);
      if (generation !== this.generation) return;

      const issues: SessionCatalogIssue[] = [];
      const directories = await this.sessionDirectories(issues);
      if (generation !== this.generation) return;
      const sessions = await this.metadata.list(directories, issues);
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
      this.issues = issues;
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
      throw requestError(
        "The session identity is ambiguous in the Pi catalog",
        409,
      );
    }
    if (!this.byId.has(id)) this.requireComplete();
    return this.byId.get(id);
  }

  async list(
    options: {
      query?: string;
      offset?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<SessionListResponse> {
    const sessions = (await this.refresh()).filter(
      (session) => !this.ambiguousIds.has(session.id),
    );
    const query = options.query?.trim().slice(0, 200) ?? "";
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
    const issues = [...this.issues];
    const filtered = query
      ? await searchSessionRecords(sessions, query, options.signal, issues)
      : sessions;

    return {
      sessions: filtered
        .slice(offset, offset + limit)
        .map((session) => this.project(session)),
      total: filtered.length,
      ...(issues.length
        ? {
            issues: [
              ...new Map(issues.map((issue) => [issue.path, issue])).values(),
            ].slice(0, 20),
          }
        : {}),
      offset,
      limit,
    };
  }

  async listByIds(ids: readonly string[]): Promise<SessionSummary[]> {
    if (ids.length === 0) return [];
    await this.refresh();
    return [...new Set(ids)].flatMap((id) => {
      if (this.ambiguousIds.has(id))
        throw requestError(
          "The session identity is ambiguous in the Pi catalog",
          409,
        );
      const record = this.byId.get(id);
      return record ? [this.project(record)] : [];
    });
  }

  /** The newest sessions of each named working directory. A folder pinned as
   * a whole is a complete navigation section, so it cannot depend on which of
   * its sessions happen to fall inside the first chronological page. */
  async listByCwds(cwds: readonly string[]): Promise<SessionSummary[]> {
    if (cwds.length === 0) return [];
    const sessions = newestPerCwd(
      (await this.refresh()).filter(
        (session) => !this.ambiguousIds.has(session.id),
      ),
      cwds,
      MAX_CURATED_SESSION_RESULTS + 1,
    );
    if (sessions.length > MAX_CURATED_SESSION_RESULTS) {
      throw requestError(
        `Curated folders contain more than ${MAX_CURATED_SESSION_RESULTS.toLocaleString("en-US")} sessions`,
        413,
      );
    }
    return sessions.map((session) => this.project(session));
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

/** Shared Host wiring: preferences seed discovery, but never own its lifetime. */
export function createHostSessionCatalog(
  startupCwd: string,
  preferences: PreferencesStore,
): SessionCatalog {
  return new SessionCatalog(
    startupCwd,
    undefined,
    async () => {
      const saved = await preferences.read();
      return [...saved.pinnedProjectCwds, ...saved.hiddenProjectCwds];
    },
    preferences.projectDirectories,
  );
}
