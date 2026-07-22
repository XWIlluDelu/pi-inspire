import { SessionManager, SettingsManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { projectNameFromCwd, type SessionListResponse, type SessionSummary } from "../shared/contracts.js";

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

function displayTitle(session: SessionRecord): string {
  const candidate = session.name?.trim() || session.firstMessage.trim();
  return candidate ? candidate.replace(/\s+/g, " ").slice(0, 120) : "Untitled session";
}

function slimSession(session: SessionInfo): SessionRecord {
  const firstMessage = session.firstMessage.slice(0, SEARCHABLE_FIRST_MESSAGE_CHARS);
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
    searchText: [session.name, firstMessage, session.cwd].filter(Boolean).join("\n").toLowerCase(),
  };
}

export interface SessionCatalogLike {
  refresh(force?: boolean): Promise<readonly SessionRecord[]>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(options?: { query?: string; offset?: number; limit?: number }): Promise<SessionListResponse>;
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
    if (!force && this.loadedAt > 0 && Date.now() - this.loadedAt < CACHE_MS) return this.cached;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const sessionDir = SettingsManager.create(this.startupCwd).getSessionDir();
      const sessions = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
      this.cached = sessions.map(slimSession);
      this.byId = new Map(this.cached.map((session) => [session.id, session]));
      this.idByPath = new Map(this.cached.map((session) => [session.path, session.id]));
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
    await this.refresh();
    return this.byId.get(id);
  }

  async list(options: { query?: string; offset?: number; limit?: number } = {}): Promise<SessionListResponse> {
    const sessions = await this.refresh();
    const query = options.query?.trim().toLowerCase().slice(0, 200) ?? "";
    const requestedOffset = Number.isFinite(options.offset) ? Math.floor(options.offset!) : 0;
    const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit!) : 40;
    const offset = Math.max(0, requestedOffset);
    const limit = Math.min(100, Math.max(1, requestedLimit));
    const filtered = query ? sessions.filter((session) => session.searchText.includes(query)) : sessions;

    return {
      sessions: filtered.slice(offset, offset + limit).map((session) => this.project(session)),
      total: filtered.length,
      offset,
      limit,
    };
  }

  project(session: SessionRecord): SessionSummary {
    const parentSessionId = session.parentSessionPath ? this.idByPath.get(session.parentSessionPath) : undefined;
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
