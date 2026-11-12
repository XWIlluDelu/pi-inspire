import {
  MAX_CURATED_SESSION_RESULTS,
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  MAX_SESSION_LIST_PAGE_SIZE,
  projectNameFromCwd,
  type SessionCatalogIssue,
  type SessionListResponse,
  type SessionSummary,
} from "../shared/contracts.js";
import { createPiSessionDirectoryResolver } from "./pi-session-directory.js";
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

function displayTitle(session: SessionRecord): string {
  const candidate = session.name?.trim() || session.firstMessage.trim();
  return candidate
    ? candidate.replace(/\s+/g, " ").slice(0, MAX_SESSION_DISPLAY_TITLE_CHARS)
    : "New session";
}

export interface SessionCatalogLike {
  refresh(
    force?: boolean,
    options?: { requireComplete?: boolean },
  ): Promise<readonly SessionRecord[]>;
  get(
    id: string,
    options?: { refresh?: boolean },
  ): Promise<SessionRecord | undefined>;
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
  rememberProjectCwd?(cwd: string): Promise<void>;
}

export class SessionCatalog implements SessionCatalogLike {
  private cached: SessionRecord[] = [];
  private searchResult: {
    query: string;
    sources: readonly SessionRecord[];
    matches: SessionRecord[];
    snippets: Map<string, string>;
  } | null = null;
  private observedProjectCwds = new Set<string>();
  private issues: SessionCatalogIssue[] = [];
  private loadedAt = 0;
  // Missing keys are unknown; a null value marks an ID shared by several files.
  private byId = new Map<string, SessionRecord | null>();
  private idByPath = new Map<string, string>();
  private generation = 0;
  private loadedGeneration = -1;
  private loading: {
    generation: number;
    promise: Promise<void>;
  } | null = null;

  constructor(
    private readonly startupCwd: string,
    private readonly metadata: Pick<SessionMetadataIndex, "list"> &
      Partial<
        Pick<SessionMetadataIndex, "readCurrent">
      > = new SessionMetadataIndex(),
    private readonly projectCwds: () => Promise<
      readonly string[]
    > = async () => [],
    private readonly projects?: ProjectDirectoryStore,
  ) {}

  async rememberProjectCwd(cwd: string): Promise<void> {
    if (this.observedProjectCwds.has(cwd)) return;
    this.observedProjectCwds.add(cwd);
    this.invalidate();
    await this.projects?.remember([cwd]);
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
    const resolveDirectory = createPiSessionDirectoryResolver();
    for (const cwd of cwds) {
      try {
        directories.add(await resolveDirectory(cwd));
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
      const cached = [...sessions].sort(compareSessionRecords);
      const byId = new Map<string, SessionRecord | null>();
      for (const session of cached)
        byId.set(session.id, byId.has(session.id) ? null : session);
      const idByPath = new Map(
        cached
          .filter((session) => byId.get(session.id) !== null)
          .map((session) => [session.path, session.id]),
      );
      this.cached = cached;
      this.issues = issues;
      this.byId = byId;
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

  async get(
    id: string,
    options?: { refresh?: boolean },
  ): Promise<SessionRecord | undefined> {
    // Opening needs stable identity/path/cwd, not freshly sorted list metadata.
    // Keep known identities usable after invalidate() so a click never pays for
    // a global JSONL rescan; explicit/list refreshes still rebuild the catalog.
    const cached = this.byId.get(id);
    if (
      cached === undefined ||
      (cached === null && this.loadedGeneration !== this.generation)
    )
      await this.refresh();
    const session = this.byId.get(id);
    if (session === null)
      throw requestError(
        "The session identity is ambiguous in the Pi catalog",
        409,
      );
    if (session === undefined) this.requireComplete();
    if (session && options?.refresh && this.metadata.readCurrent)
      return (await this.metadata.readCurrent(session)) ?? undefined;
    return session;
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
      (session) => this.byId.get(session.id) !== null,
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
    const snippets = new Map<string, string>();
    const filtered = query
      ? await this.searchRecords(
          sessions,
          query,
          options.signal,
          issues,
          snippets,
        )
      : sessions;

    return {
      sessions: filtered.slice(offset, offset + limit).map((session) => {
        const summary = this.project(session);
        const matchSnippet = snippets.get(session.id);
        return matchSnippet ? { ...summary, matchSnippet } : summary;
      }),
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

  private async searchRecords(
    sessions: readonly SessionRecord[],
    query: string,
    signal: AbortSignal | undefined,
    issues: SessionCatalogIssue[],
    snippets: Map<string, string>,
  ): Promise<SessionRecord[]> {
    signal?.throwIfAborted();
    const cached = this.searchResult;
    if (
      cached?.query === query &&
      cached.sources.length === sessions.length &&
      sessions.every((session, index) => session === cached.sources[index])
    ) {
      for (const [id, snippet] of cached.snippets) snippets.set(id, snippet);
      return cached.matches;
    }
    const generation = this.generation;
    const searchIssues: SessionCatalogIssue[] = [];
    const found = new Map<string, string>();
    const matches = await searchSessionRecords(
      sessions,
      query,
      signal,
      searchIssues,
      found,
    );
    issues.push(...searchIssues);
    for (const [id, snippet] of found) snippets.set(id, snippet);
    // Retain only the last successful query; failed reads remain recoverable.
    if (generation === this.generation && searchIssues.length === 0) {
      this.searchResult = {
        query,
        sources: sessions,
        matches,
        snippets: found,
      };
    }
    return matches;
  }

  async listByIds(ids: readonly string[]): Promise<SessionSummary[]> {
    if (ids.length === 0) return [];
    await this.refresh();
    return [...new Set(ids)].flatMap((id) => {
      const record = this.byId.get(id);
      if (record === null)
        throw requestError(
          "The session identity is ambiguous in the Pi catalog",
          409,
        );
      return record ? [this.project(record)] : [];
    });
  }

  /** The newest sessions of each named working directory. A folder pinned as
   * a whole is a complete navigation section, so it cannot depend on which of
   * its sessions happen to fall inside the first chronological page. */
  async listByCwds(cwds: readonly string[]): Promise<SessionSummary[]> {
    if (cwds.length === 0) return [];
    const requested = new Set(cwds);
    const sessions = (await this.refresh()).filter(
      (session) =>
        requested.has(session.cwd) && this.byId.get(session.id) !== null,
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
    this.searchResult = null;
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
