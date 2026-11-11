import {
  type InspirePreferences,
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type SessionCatalogIssue,
  type SessionRuntimeStatus,
  type SessionSummary,
} from "../../shared/contracts";
import type { ExternalSessionActivities } from "../../shared/session-activity";
import { type Api, ApiError } from "../api";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import { sessionCurationOwners } from "../session-curation";

const SESSION_PAGE_SIZE = 40;

type SessionListOperation = "reset" | "older" | "refresh" | null;

export interface SessionCatalogState {
  sessions: SessionSummary[];
  sessionQuery: string;
  sessionListTotal: number;
  sessionListNextOffset: number;
  sessionListLoading: boolean;
  sessionListLoadingOlder: boolean;
  sessionListHydrating: boolean;
  sessionListOperation: SessionListOperation;
  sessionListError: string | null;
  prefs: InspirePreferences;
  sessionId: string | null;
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  externalSessionActivities?: ExternalSessionActivities;
}

export interface SessionCatalogPatch {
  sessions?: SessionSummary[];
  sessionQuery?: string;
  sessionListTotal?: number;
  sessionListNextOffset?: number;
  sessionListLoading?: boolean;
  sessionListLoadingOlder?: boolean;
  sessionListHydrating?: boolean;
  sessionListOperation?: SessionListOperation;
  sessionListError?: string | null;
  sessionListIssues?: SessionCatalogIssue[];
}

function baseLoadingPatch(operation: "reset" | "refresh"): SessionCatalogPatch {
  return {
    sessionListLoading: true,
    sessionListLoadingOlder: false,
    sessionListHydrating: false,
    sessionListOperation: operation,
    sessionListError: null,
  };
}

function uniqueSessions(
  ...sources: Iterable<SessionSummary>[]
): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const session of source) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  return sessions;
}

type VisibleRead = {
  recovery: RecoveryBackoff;
  request: AbortController | null;
};
type SessionListRetry =
  | { kind: "reset"; query: string }
  | { kind: "older"; query: string; offset: number }
  | { kind: "refresh"; query: string };

interface SessionCatalogControllerHost {
  state(): SessionCatalogState;
  patch(patch: SessionCatalogPatch): void;
  api(): Api | null;
  confirmedPreferences(): InspirePreferences;
  handleAuthFailure(): void;
}

/**
 * Owns chronological session pagination, curation/live hydration, retry state,
 * and its query-scoped request generations. The host remains the only public
 * snapshot authority; this controller never owns selection or a second session
 * catalog projection.
 */
export class SessionCatalogController {
  private basePages: SessionSummary[] = [];
  private readonly hydration = new Map<string, SessionSummary>();
  private loadTicket = 0;
  private listAbort = new AbortController();
  private curationTicket = 0;
  private curationRequestKey: string | null = null;
  private olderPromise: Promise<void> | null = null;
  private retry: SessionListRetry | null = null;
  private readonly visibleReads = new Map<string, VisibleRead>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private preserveRecovery = new RecoveryBackoff();
  private curationRecovery = new RecoveryBackoff();
  private curationRecoveryOwner = "";

  constructor(private readonly host: SessionCatalogControllerHost) {}

  private retireListRequest(): void {
    this.listAbort.abort();
    this.listAbort = new AbortController();
  }

  private beginListGeneration(): number {
    this.preserveRecovery.reset();
    for (const id of this.visibleReads.keys()) this.retireVisibleRead(id);
    this.retireListRequest();
    this.cancelCurationRequest();
    this.olderPromise = null;
    this.retry = null;
    return ++this.loadTicket;
  }

  /** Invalidates all owned work when bootstrap/auth changes the API client.
   * Confirmed rows stay visible, but a former transport cannot publish over the
   * current generation or turn a later successful pairing into a 401. */
  invalidate(): void {
    this.clearSearchTimer();
    this.beginListGeneration();
    const state = this.host.state();
    if (
      !state.sessionListLoading &&
      !state.sessionListLoadingOlder &&
      !state.sessionListHydrating &&
      state.sessionListOperation === null &&
      state.sessionListError === null
    ) {
      return;
    }
    this.host.patch({
      sessionListLoading: false,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: null,
      sessionListError: null,
    });
  }

  load(query: string): Promise<void> {
    this.clearSearchTimer();
    if (!this.host.api()) return Promise.resolve();
    const state = this.host.state();
    const queryChanged = query !== state.sessionQuery;
    // A prior append may finish on the wire, but it cannot coalesce with this
    // generation or publish its rows.
    const ticket = this.beginListGeneration();
    if (queryChanged) this.basePages = [];
    this.host.patch({
      ...(queryChanged
        ? {
            sessionQuery: query,
            sessions: query.trim() ? [] : [...this.hydration.values()],
            sessionListTotal: 0,
            sessionListNextOffset: 0,
          }
        : {}),
      ...baseLoadingPatch("reset"),
    });
    return this.requestReset(query, ticket);
  }

  /** Search changes query ownership synchronously, then issues its debounced
   * reset. Old-query pages cannot remain rendered or win while typing. */
  search(query: string): void {
    this.beginListGeneration();
    this.basePages = [];
    this.host.patch({
      sessionQuery: query,
      sessions: query.trim() ? [] : [...this.hydration.values()],
      sessionListTotal: 0,
      sessionListNextOffset: 0,
      ...baseLoadingPatch("reset"),
    });
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => void this.load(query), 180);
  }

  /** Refetch the exact already-consumed extent after a runtime/catalog hint. */
  refreshLoaded(): Promise<void> {
    const state = this.host.state();
    return this.preserve(
      state.sessionQuery,
      state.sessionListNextOffset,
      state.sessionListTotal,
    );
  }

  /** Rebuild a caller-supplied consumed extent after an optimistic deletion. */
  preserve(
    query: string,
    preserveOffset: number,
    preserveTotal: number,
  ): Promise<void> {
    if (!this.host.api() || query !== this.host.state().sessionQuery)
      return Promise.resolve();
    const foreground = this.host.state().sessionListLoading;
    const ticket = this.beginListGeneration();
    this.host.patch({
      sessionListLoading: foreground,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: foreground ? "reset" : null,
      sessionListError: null,
    });
    return this.requestReset(
      query,
      ticket,
      preserveOffset,
      preserveTotal,
      foreground ? "reset" : "preserve",
    );
  }

  loadOlder(
    retry?: Extract<SessionListRetry, { kind: "older" }>,
  ): Promise<void> {
    const api = this.host.api();
    if (!api) return Promise.resolve();
    const state = this.host.state();
    if (
      retry &&
      (retry.query !== state.sessionQuery ||
        retry.offset !== state.sessionListNextOffset)
    ) {
      if (this.retry === retry) this.retry = null;
      return Promise.resolve();
    }
    if (this.olderPromise) return this.olderPromise;
    if (state.sessionListLoading || state.sessionListLoadingOlder)
      return Promise.resolve();
    const offset = retry?.offset ?? state.sessionListNextOffset;
    if (offset >= state.sessionListTotal && !retry) return Promise.resolve();
    const query = retry?.query ?? state.sessionQuery;
    this.retireListRequest();
    const ticket = ++this.loadTicket;
    const signal = this.listAbort.signal;
    this.retry = null;
    this.host.patch({
      sessionListLoadingOlder: true,
      sessionListOperation: "older",
      sessionListError: null,
    });
    const request = (async () => {
      try {
        const page = await api.sessions(
          query,
          offset,
          SESSION_PAGE_SIZE,
          signal,
        );
        if (!this.owns(ticket, query, api)) return;
        if (
          page.offset !== offset ||
          (page.sessions.length === 0 && offset < page.total)
        ) {
          throw new Error(
            "Session paging did not advance from its requested offset",
          );
        }
        this.basePages = uniqueSessions(this.basePages, page.sessions);
        this.retry = null;
        this.host.patch({
          sessionListTotal: page.total,
          sessionListIssues: page.issues ?? [],
          // Consumed server rows, including duplicate identities, own the
          // cursor. Rendered/union length is deliberately irrelevant.
          sessionListNextOffset: page.offset + page.sessions.length,
          sessionListLoadingOlder: false,
          sessionListOperation: null,
          sessionListError: null,
        });
        this.publishUnion();
      } catch (error) {
        if (!this.owns(ticket, query, api)) return;
        if (error instanceof ApiError && error.status === 401) {
          this.retry = null;
          this.host.patch({
            sessionListLoadingOlder: false,
            sessionListOperation: null,
          });
          this.host.handleAuthFailure();
          return;
        }
        this.retry = { kind: "older", query, offset };
        this.host.patch({
          sessionListLoadingOlder: false,
          sessionListOperation: "older",
          sessionListError:
            error instanceof Error
              ? error.message
              : "Failed to load older sessions",
        });
      }
    })();
    const tracked = request.finally(() => {
      if (this.olderPromise === tracked) this.olderPromise = null;
    });
    this.olderPromise = tracked;
    return tracked;
  }

  async refresh(retryQuery = this.host.state().sessionQuery): Promise<void> {
    const api = this.host.api();
    if (!api) return;
    const state = this.host.state();
    if (retryQuery !== state.sessionQuery) {
      if (this.retry?.kind === "refresh" && this.retry.query === retryQuery) {
        this.retry = null;
      }
      return;
    }
    const query = retryQuery;
    const ticket = this.beginListGeneration();
    this.host.patch(baseLoadingPatch("refresh"));
    try {
      await api.refreshSessions();
      if (!this.owns(ticket, query, api)) return;
      await this.requestReset(query, ticket);
    } catch (error) {
      if (!this.owns(ticket, query, api)) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.patch({
          sessionListLoading: false,
          sessionListOperation: null,
        });
        this.host.handleAuthFailure();
      } else {
        this.retry = { kind: "refresh", query };
        this.host.patch({
          sessionListLoading: false,
          sessionListOperation: "refresh",
          sessionListError:
            error instanceof Error
              ? error.message
              : "Failed to refresh sessions",
        });
      }
    }
  }

  retryCurrent(): Promise<void> {
    const retry = this.retry;
    if (!retry) return this.load(this.host.state().sessionQuery);
    switch (retry.kind) {
      case "older":
        return this.loadOlder(retry);
      case "refresh":
        return this.refresh(retry.query);
      case "reset":
        return this.load(retry.query);
    }
  }

  /** Ensures a selected/live row is reachable without advancing chronological
   * pagination or disturbing a nonempty catalog search. */
  ensureVisible(id: string): void {
    void this.hydrateVisible(id);
  }

  remove(id: string): void {
    this.cancelCurationRequest();
    if (this.host.state().sessionListHydrating)
      this.host.patch({ sessionListHydrating: false });
    this.basePages = this.basePages.filter((session) => session.id !== id);
    this.hydration.delete(id);
    this.retireVisibleRead(id);
    this.publishUnion();
  }

  private async requestReset(
    query: string,
    ticket: number,
    preserveOffset = 0,
    preserveTotal = 0,
    operation: "reset" | "preserve" = "reset",
  ): Promise<void> {
    const api = this.host.api();
    if (!api) return;
    const signal = this.listAbort.signal;
    try {
      const rows: SessionSummary[] = [];
      let page = await api.sessions(
        query,
        0,
        preserveOffset > 0
          ? Math.min(MAX_SESSION_LIST_PAGE_SIZE, Math.max(1, preserveOffset))
          : SESSION_PAGE_SIZE,
        signal,
      );
      if (page.offset !== 0 || (page.sessions.length === 0 && page.total > 0)) {
        throw new Error(
          "Session paging did not advance from its requested offset",
        );
      }
      rows.push(...page.sessions);
      const issues = new Map(
        (page.issues ?? []).map((issue) => [issue.path, issue]),
      );
      let nextOffset = page.sessions.length;
      let total = page.total;
      if (!this.owns(ticket, query, api)) return;
      // New rows inserted ahead of an already-consumed cursor must not displace
      // confirmed rows. Consume the positive total delta as well as the prior
      // extent; deletions simply stop at the new total.
      const targetOffset =
        preserveOffset > 0
          ? Math.min(total, preserveOffset + Math.max(0, total - preserveTotal))
          : 0;
      while (
        targetOffset > 0 &&
        nextOffset < targetOffset &&
        nextOffset < total
      ) {
        if (!this.owns(ticket, query, api)) return;
        const priorOffset = nextOffset;
        page = await api.sessions(
          query,
          nextOffset,
          Math.min(MAX_SESSION_LIST_PAGE_SIZE, targetOffset - nextOffset),
          signal,
        );
        if (!this.owns(ticket, query, api)) return;
        if (page.offset !== priorOffset) {
          throw new Error("Session paging resumed from an unexpected offset");
        }
        rows.push(...page.sessions);
        for (const issue of page.issues ?? []) issues.set(issue.path, issue);
        nextOffset = page.offset + page.sessions.length;
        total = page.total;
        if (nextOffset <= priorOffset && priorOffset < total) {
          throw new Error(
            `Session refresh stopped at ${nextOffset} before the preserved extent ${targetOffset}`,
          );
        }
      }
      if (!this.owns(ticket, query, api)) return;
      this.preserveRecovery.reset();
      this.basePages = uniqueSessions(rows);
      this.pruneHydration();
      this.retry = null;
      this.host.patch({
        sessionListTotal: total,
        sessionListIssues: [...issues.values()],
        sessionListNextOffset: nextOffset,
        sessionListLoading: false,
        sessionListLoadingOlder: false,
        sessionListOperation: null,
        sessionListError: null,
      });
      this.publishUnion();
      // Supplemental discovery must never hold back a confirmed base page.
      if (!query.trim()) await this.hydrateCuration();
    } catch (error) {
      if (!this.owns(ticket, query, api)) return;
      if (error instanceof ApiError && error.status === 401) {
        this.retry = null;
        this.host.patch({
          sessionListLoading: false,
          sessionListLoadingOlder: false,
          sessionListOperation: null,
        });
        this.host.handleAuthFailure();
        return;
      }
      if (operation === "preserve") {
        this.host.patch({
          sessionListLoading: false,
          sessionListLoadingOlder: false,
          sessionListOperation: null,
          sessionListError: null,
        });
        if (isTransientFailure(error))
          this.preserveRecovery.schedule(() => {
            if (this.owns(ticket, query, api))
              void this.requestReset(
                query,
                ticket,
                preserveOffset,
                preserveTotal,
                operation,
              );
          });
      } else {
        this.retry = { kind: "reset", query };
        this.host.patch({
          sessionListLoading: false,
          sessionListLoadingOlder: false,
          sessionListOperation: operation,
          sessionListError:
            error instanceof Error ? error.message : "Failed to list sessions",
        });
      }
    }
  }

  private publishUnion(): void {
    const state = this.host.state();
    this.host.patch({
      sessions: uniqueSessions(
        this.basePages,
        state.sessionQuery.trim() ? [] : this.hydration.values(),
      ),
    });
  }

  private curationOwnerKey(): string {
    const { ids, cwds } = sessionCurationOwners(
      this.host.state().prefs,
      this.host.confirmedPreferences(),
    );
    return JSON.stringify([[...ids].sort(), [...cwds].sort()]);
  }

  private hydrationOwners(prefs: InspirePreferences): {
    ids: Set<string>;
    cwds: Set<string>;
  } {
    const { ids, cwds } = sessionCurationOwners(
      prefs,
      this.host.confirmedPreferences(),
    );
    for (const id of this.liveSessionIds()) ids.add(id);
    return { ids, cwds };
  }

  private liveSessionIds(): Set<string> {
    const { sessionId, sessionStatuses, externalSessionActivities } =
      this.host.state();
    return new Set([
      ...(sessionId ? [sessionId] : []),
      ...Object.keys(sessionStatuses),
      ...Object.keys(externalSessionActivities ?? {}),
    ]);
  }

  private hasSession(id: string): boolean {
    return (
      this.hydration.has(id) || this.basePages.some((row) => row.id === id)
    );
  }

  private retireVisibleRead(id: string): void {
    const read = this.visibleReads.get(id);
    this.visibleReads.delete(id);
    read?.request?.abort();
    read?.recovery.reset();
  }

  private cancelCurationRequest(): void {
    this.curationRecovery.reset();
    this.curationRecoveryOwner = "";
    this.curationTicket += 1;
    this.curationRequestKey = null;
  }

  private pruneHydration(): boolean {
    const { ids, cwds } = this.hydrationOwners(this.host.state().prefs);
    const baseIds = new Set(this.basePages.map((session) => session.id));
    let changed = false;
    for (const [id, session] of this.hydration) {
      if (!baseIds.has(id) && (ids.has(id) || cwds.has(session.cwd))) continue;
      this.hydration.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Reclassify already-known rows synchronously. Optimistic removals retain
   * the host-confirmed owners until the preference write settles, so an
   * off-page row cannot disappear before a rejected write rolls back. */
  reconcileCuration(): void {
    const ownerKey = this.curationOwnerKey();
    const staleRequest =
      this.curationRequestKey !== null && this.curationRequestKey !== ownerKey;
    if (staleRequest) {
      this.cancelCurationRequest();
      this.host.patch({ sessionListHydrating: false });
    }

    const liveIds = this.liveSessionIds();
    for (const id of this.visibleReads.keys())
      if (!liveIds.has(id) || this.hasSession(id)) this.retireVisibleRead(id);
    if (this.pruneHydration()) this.publishUnion();
  }

  /** Hydrate only newly curated off-page identities/folders. Chronological
   * pages, totals, and cursors stay untouched, and the operation remains a
   * quiet background reconciliation, including its bounded recovery window. */
  async hydrateCuration(): Promise<void> {
    this.curationRecovery.cancel();
    this.reconcileCuration();
    const api = this.host.api();
    const state = this.host.state();
    if (!api || state.sessionQuery.trim()) return;
    const ticket = ++this.curationTicket;
    const ownerKey = this.curationOwnerKey();
    if (ownerKey !== this.curationRecoveryOwner) {
      this.curationRecovery.reset();
      this.curationRecoveryOwner = ownerKey;
    }
    const query = state.sessionQuery;
    const base = this.basePages;
    this.curationRequestKey = ownerKey;
    this.host.patch({ sessionListHydrating: true });
    const ownsRequest = () =>
      ticket === this.curationTicket &&
      ownerKey === this.curationOwnerKey() &&
      query === this.host.state().sessionQuery &&
      api === this.host.api();

    try {
      const hydration = await this.readSupplementalRows(api, base, ownsRequest);
      if (!hydration || !ownsRequest()) return;
      this.curationRecovery.reset();
      // An older page or live lookup may have completed while reading the
      // supplemental rows. Merge against the current catalog in either order.
      for (const [id, session] of hydration) this.hydration.set(id, session);
      this.pruneHydration();
      this.publishUnion();
      for (const id of this.liveSessionIds())
        void this.hydrateVisible(id, true);
    } catch (error) {
      if (!ownsRequest()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      if (isTransientFailure(error))
        this.curationRecovery.schedule(() => {
          if (ownsRequest()) void this.hydrateCuration();
        });
    } finally {
      if (ownsRequest()) {
        this.curationRequestKey = null;
        this.host.patch({ sessionListHydrating: false });
      }
    }
  }

  /** Hydration is a separate atomic union. During an optimistic preference
   * write, rows owned by the last confirmed curation survive until the host
   * accepts or rejects the patch. Every request stays inside route caps. */
  private async readSupplementalRows(
    api: Api,
    base: readonly SessionSummary[],
    isCurrent: () => boolean,
  ): Promise<Map<string, SessionSummary> | null> {
    const { ids, cwds } = this.hydrationOwners(this.host.state().prefs);
    const baseIds = new Set(base.map((session) => session.id));
    const hydration = new Map<string, SessionSummary>();
    const reads = [
      {
        field: "id",
        owners: [...ids].filter(
          (id) => !baseIds.has(id) && !this.hydration.has(id),
        ),
        limit: MAX_SESSION_ID_HYDRATION_IDS,
        read: (chunk: string[]) => api.sessionsByIds(chunk),
      },
      {
        field: "cwd",
        owners: [...cwds],
        limit: MAX_SESSION_CWD_HYDRATION_CWDS,
        read: (chunk: string[]) => api.sessionsByCwds(chunk),
      },
    ] as const;
    for (const { field, owners, limit, read } of reads) {
      for (let index = 0; index < owners.length; index += limit) {
        if (!isCurrent()) return null;
        const chunk = owners.slice(index, index + limit);
        const response = await read(chunk);
        if (!isCurrent()) return null;
        const requested = new Set(chunk);
        for (const session of response.sessions) {
          if (requested.has(session[field]) && !baseIds.has(session.id))
            hydration.set(session.id, session);
        }
      }
    }
    return hydration;
  }

  private async hydrateVisible(id: string, delayed = false): Promise<void> {
    const api = this.host.api();
    const previous = this.visibleReads.get(id);
    if (
      !api ||
      this.host.state().sessionQuery.trim() ||
      previous?.request ||
      this.hasSession(id)
    )
      return;

    const read = previous ?? { recovery: new RecoveryBackoff(), request: null };
    const request = new AbortController();
    const { signal } = request;
    read.request = request;
    this.visibleReads.set(id, read);
    const owns = () => {
      const { sessionId, sessionStatuses, externalSessionActivities } =
        this.host.state();
      return (
        !signal.aborted &&
        this.host.api() === api &&
        (sessionId === id ||
          Object.hasOwn(sessionStatuses, id) ||
          Object.hasOwn(externalSessionActivities ?? {}, id))
      );
    };

    try {
      if (delayed && (!(await read.recovery.wait(signal)) || !owns())) return;
      do {
        try {
          const { sessions } = await api.sessionsByIds([id], signal);
          if (!owns() || this.hasSession(id)) return;
          const session = sessions.find((row) => row.id === id);
          if (session) {
            this.hydration.set(id, session);
            this.publishUnion();
            return;
          }
          // A new Pi session may not have written its catalog row yet.
        } catch (error) {
          if (!owns() || this.hasSession(id)) return;
          if (error instanceof ApiError && error.status === 401) {
            this.host.handleAuthFailure();
            return;
          }
          if (!isTransientFailure(error)) return;
        }
      } while (
        (await read.recovery.wait(signal)) &&
        owns() &&
        !this.hasSession(id)
      );
    } finally {
      if (this.visibleReads.get(id) === read) {
        read.request = null;
        if (!owns() || this.hasSession(id)) this.retireVisibleRead(id);
      }
    }
  }

  private clearSearchTimer(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  private owns(ticket: number, query: string, api: Api): boolean {
    return (
      ticket === this.loadTicket &&
      query === this.host.state().sessionQuery &&
      this.host.api() === api
    );
  }
}
