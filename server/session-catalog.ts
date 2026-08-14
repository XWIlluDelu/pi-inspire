import {
  SessionManager,
  SettingsManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  MAX_SESSION_LIST_PAGE_SIZE,
  projectNameFromCwd,
  type SessionListResponse,
  type SessionSummary,
} from "../shared/contracts.js";

const CACHE_MS = 5_000;
const SEARCHABLE_FIRST_MESSAGE_CHARS = 10_000;

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

function slimSession(session: SessionInfo): SessionRecord {
  const firstMessage = session.firstMessage.slice(
    0,
    SEARCHABLE_FIRST_MESSAGE_CHARS,
  );
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    parentSessionPath: session.parentSessionPath,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage,
    searchText: [session.name, firstMessage, session.cwd]
      .filter(Boolean)
      .join("\n")
      .toLowerCase(),
  };
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
  private idByPath = new Map<string, string>();
  private loading: Promise<readonly SessionRecord[]> | null = null;

  constructor(private readonly startupCwd: string) {}

  async refresh(force = false): Promise<readonly SessionRecord[]> {
    if (!force && this.loadedAt > 0 && Date.now() - this.loadedAt < CACHE_MS)
      return this.cached;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const sessionDir = SettingsManager.create(
        this.startupCwd,
      ).getSessionDir();
      const sessions = sessionDir
        ? await SessionManager.listAll(sessionDir)
        : await SessionManager.listAll();
      // Pi storage enumeration is not an ordering contract. Page boundaries
      // require one deterministic newest-first order with stable tie-breakers.
      this.cached = orderSessionRecords(sessions.map(slimSession));
      this.byId = new Map(this.cached.map((session) => [session.id, session]));
      this.idByPath = new Map(
        this.cached.map((session) => [session.path, session.id]),
      );
      this.loadedAt = Date.now();
      return this.cached;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    // Opening needs stable identity/path/cwd, not freshly sorted list metadata.
    // Keep known identities usable after invalidate() so a click never pays for
    // a global JSONL rescan; explicit/list refreshes still rebuild the catalog.
    const cached = this.byId.get(id);
    if (cached) return cached;
    await this.refresh();
    return this.byId.get(id);
  }

  async list(
    options: { query?: string; offset?: number; limit?: number } = {},
  ): Promise<SessionListResponse> {
    const sessions = await this.refresh();
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
    return [...new Set(ids)].flatMap((id) => {
      const session = this.byId.get(id);
      return session ? [this.project(session)] : [];
    });
  }

  /** The newest sessions of each named working directory. A folder pinned as
   * a whole is a complete navigation section, so it cannot depend on which of
   * its sessions happen to fall inside the first chronological page. */
  async listByCwds(
    cwds: readonly string[],
    limitPerCwd = 40,
  ): Promise<SessionSummary[]> {
    if (cwds.length === 0) return [];
    return newestPerCwd(await this.refresh(), cwds, limitPerCwd).map(
      (session) => this.project(session),
    );
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
    this.loadedAt = 0;
  }
}
