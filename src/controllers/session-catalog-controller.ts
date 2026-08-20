import {
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type InspirePreferences,
  type SessionRuntimeStatus,
  type SessionSummary,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";

const SESSION_PAGE_SIZE = 40;

type SessionListOperation =
  | "reset"
  | "older"
  | "refresh"
  | "preserve"
  | "hydrate"
  | "curation"
  | null;

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
}

type HydrationOwner = { id: string; query: string; ticket: number };
type SessionListRetry =
  | { kind: "reset"; query: string }
  | { kind: "older"; query: string; offset: number }
  | { kind: "refresh"; query: string }
  | { kind: "preserve"; query: string; offset: number; total: number }
  | { kind: "hydrate"; owner: HydrationOwner }
  | { kind: "curation"; ownerKey: string };

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
  private hydration = new Map<string, SessionSummary>();
  private loadTicket = 0;
  private curationTicket = 0;
  private curationRequestKey: string | null = null;
  private curationPending = false;
  private olderPromise: Promise<void> | null = null;
  private retry: SessionListRetry | null = null;
  private hydrationInFlight = new Set<string>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SessionCatalogControllerHost) {}

  /** Invalidates all owned work when bootstrap/auth changes the API client.
   * Confirmed rows stay visible, but a former transport cannot publish over the
   * current generation or turn a later successful pairing into a 401. */
  invalidate(): void {
    this.loadTicket += 1;
    this.cancelCurationRequest();
    this.curationPending = false;
    this.olderPromise = null;
    this.retry = null;
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
    if (!this.host.api()) return Promise.resolve();
    this.cancelCurationRequest();
    this.curationPending = false;
    const state = this.host.state();
    const queryChanged = query !== state.sessionQuery;
    const ticket = ++this.loadTicket;
    // A prior append may finish on the wire, but it cannot coalesce with this
    // generation or publish its rows.
    this.olderPromise = null;
    this.retry = null;
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
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "reset",
      sessionListError: null,
    });
    return this.requestReset(query, ticket);
  }

  /** Search changes query ownership synchronously, then issues its debounced
   * reset. Old-query pages cannot remain rendered or win while typing. */
  search(query: string): void {
    ++this.loadTicket;
    this.cancelCurationRequest();
    this.curationPending = false;
    this.olderPromise = null;
    this.retry = null;
    this.basePages = [];
    this.host.patch({
      sessionQuery: query,
      sessions: query.trim() ? [] : [...this.hydration.values()],
      sessionListTotal: 0,
      sessionListNextOffset: 0,
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "reset",
      sessionListError: null,
    });
    if (this.searchTimer) clearTimeout(this.searchTimer);
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
    this.cancelCurationRequest();
    this.curationPending = false;
    const ticket = ++this.loadTicket;
    this.olderPromise = null;
    this.retry = null;
    this.host.patch({
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "preserve",
      sessionListError: null,
    });
    return this.requestReset(
      query,
      ticket,
      preserveOffset,
      preserveTotal,
      "preserve",
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
    this.cancelCurationRequest();
    this.curationPending = false;
    const ticket = ++this.loadTicket;
    this.retry = null;
    this.host.patch({
      sessionListLoadingOlder: true,
      sessionListHydrating: false,
      sessionListOperation: "older",
      sessionListError: null,
    });
    const request = (async () => {
      try {
        const page = await api.sessions(query, offset, SESSION_PAGE_SIZE);
        if (!this.owns(ticket, query, api)) return;
        const seen = new Set(this.basePages.map((session) => session.id));
        const appended = [...this.basePages];
        for (const session of page.sessions) {
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          appended.push(session);
        }
        this.basePages = appended;
        this.retry = null;
        this.host.patch({
          sessionListTotal: page.total,
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
      if (this.owns(ticket, query, api)) this.runPendingCuration();
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
    this.cancelCurationRequest();
    this.curationPending = false;
    const ticket = ++this.loadTicket;
    this.olderPromise = null;
    this.retry = null;
    this.host.patch({
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "refresh",
      sessionListError: null,
    });
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
    } finally {
      if (this.owns(ticket, query, api)) this.runPendingCuration();
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
      case "preserve":
        return this.preserve(retry.query, retry.offset, retry.total);
      case "reset":
        return this.load(retry.query);
      case "hydrate":
        if (!this.hydrationOwnerIsCurrent(retry.owner)) {
          this.clearHydrationRetry();
          this.host.patch({
            sessionListHydrating: false,
            sessionListOperation: null,
            sessionListError: null,
          });
          return Promise.resolve();
        }
        return this.hydrateVisible(retry.owner, true);
      case "curation":
        if (retry.ownerKey !== this.curationOwnerKey()) {
          this.retry = null;
          this.host.patch({
            sessionListHydrating: false,
            sessionListOperation: null,
            sessionListError: null,
          });
          this.reconcileCuration();
          return Promise.resolve();
        }
        return this.hydrateCuration();
    }
  }

  /** Ensures a selected/live row is reachable without advancing chronological
   * pagination or disturbing a nonempty catalog search. */
  ensureVisible(id: string): void {
    const state = this.host.state();
    if (!this.host.api() || state.sessionQuery.trim()) return;
    const owner = { id, query: state.sessionQuery, ticket: this.loadTicket };
    void this.hydrateVisible(owner);
  }

  remove(id: string): void {
    this.cancelCurationRequest();
    this.curationPending = false;
    if (this.host.state().sessionListOperation === "curation") {
      this.host.patch({
        sessionListHydrating: false,
        sessionListOperation: null,
        sessionListError: null,
      });
    }
    this.basePages = this.basePages.filter((session) => session.id !== id);
    this.hydration.delete(id);
    this.hydrationInFlight.delete(id);
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
    try {
      const rows: SessionSummary[] = [];
      let page = await api.sessions(
        query,
        0,
        preserveOffset > 0
          ? Math.min(MAX_SESSION_LIST_PAGE_SIZE, Math.max(1, preserveOffset))
          : SESSION_PAGE_SIZE,
      );
      rows.push(...page.sessions);
      let nextOffset = page.offset + page.sessions.length;
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
        );
        if (!this.owns(ticket, query, api)) return;
        rows.push(...page.sessions);
        nextOffset = page.offset + page.sessions.length;
        total = page.total;
        if (nextOffset <= priorOffset) {
          throw new Error(
            `Session refresh stopped at ${nextOffset} before the preserved extent ${targetOffset}`,
          );
        }
      }
      if (!this.owns(ticket, query, api)) return;
      const hydration = query.trim()
        ? new Map<string, SessionSummary>()
        : await this.hydrateUnion(rows, this.host.state().prefs, () =>
            this.owns(ticket, query, api),
          );
      if (!hydration || !this.owns(ticket, query, api)) return;
      const deduped: SessionSummary[] = [];
      const seen = new Set<string>();
      for (const session of rows) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        deduped.push(session);
      }
      this.basePages = deduped;
      this.hydration = hydration;
      this.pruneHydration();
      this.retry = null;
      this.host.patch({
        sessionListTotal: total,
        sessionListNextOffset: nextOffset,
        sessionListLoading: false,
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
          sessionListLoading: false,
          sessionListLoadingOlder: false,
          sessionListOperation: null,
        });
        this.host.handleAuthFailure();
        return;
      }
      this.retry =
        operation === "preserve"
          ? {
              kind: "preserve",
              query,
              offset: preserveOffset,
              total: preserveTotal,
            }
          : { kind: "reset", query };
      this.host.patch({
        sessionListLoading: false,
        sessionListLoadingOlder: false,
        sessionListOperation: operation,
        sessionListError:
          error instanceof Error ? error.message : "Failed to list sessions",
      });
    } finally {
      if (this.owns(ticket, query, api)) this.runPendingCuration();
    }
  }

  private publishUnion(): void {
    const state = this.host.state();
    const sessions: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const session of this.basePages) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
    if (!state.sessionQuery.trim()) {
      for (const session of this.hydration.values()) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        sessions.push(session);
      }
    }
    this.host.patch({ sessions });
  }

  private curationIds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedSessionIds, ...prefs.hiddenSessionIds]);
  }

  private curationProjectCwds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedProjectCwds, ...prefs.hiddenProjectCwds]);
  }

  private curationOwnerKey(): string {
    const state = this.host.state();
    const confirmed = this.host.confirmedPreferences();
    const ids = new Set([
      ...this.curationIds(state.prefs),
      ...this.curationIds(confirmed),
    ]);
    const cwds = new Set([
      ...this.curationProjectCwds(state.prefs),
      ...this.curationProjectCwds(confirmed),
    ]);
    return JSON.stringify([[...ids].sort(), [...cwds].sort()]);
  }

  private hydrationOwners(prefs: InspirePreferences): {
    ids: Set<string>;
    cwds: Set<string>;
  } {
    const confirmed = this.host.confirmedPreferences();
    const ids = new Set([
      ...this.curationIds(prefs),
      ...this.curationIds(confirmed),
    ]);
    const state = this.host.state();
    if (state.sessionId) ids.add(state.sessionId);
    for (const id of Object.keys(state.sessionStatuses)) ids.add(id);
    return {
      ids,
      cwds: new Set([
        ...this.curationProjectCwds(prefs),
        ...this.curationProjectCwds(confirmed),
      ]),
    };
  }

  private cancelCurationRequest(): void {
    this.curationTicket += 1;
    this.curationRequestKey = null;
    if (this.retry?.kind === "curation") this.retry = null;
  }

  private runPendingCuration(): void {
    if (!this.curationPending) return;
    this.curationPending = false;
    void this.hydrateCuration();
  }

  private pruneHydration(): boolean {
    const { ids, cwds } = this.hydrationOwners(this.host.state().prefs);
    let changed = false;
    for (const [id, session] of this.hydration) {
      if (ids.has(id) || cwds.has(session.cwd)) continue;
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
    const staleRetry =
      this.retry?.kind === "curation" && this.retry.ownerKey !== ownerKey;
    if (staleRequest || staleRetry) {
      this.cancelCurationRequest();
      if (this.host.state().sessionListOperation === "curation") {
        this.host.patch({
          sessionListHydrating: false,
          sessionListOperation: null,
          sessionListError: null,
        });
      }
    }

    if (this.pruneHydration()) this.publishUnion();
  }

  /** Hydrate only newly curated off-page identities/folders. Chronological
   * pages, totals, and cursors stay untouched, and the operation remains a
   * quiet background reconciliation unless it fails and needs a retry. */
  async hydrateCuration(): Promise<void> {
    this.reconcileCuration();
    const api = this.host.api();
    const state = this.host.state();
    if (!api || state.sessionQuery.trim()) return;
    if (state.sessionListLoading) {
      this.curationPending = true;
      return;
    }
    if (state.sessionListLoadingOlder) {
      // A newly curated off-page owner must become reachable immediately. The
      // already confirmed base extent remains valid while the old append is
      // invalidated and discarded when it eventually leaves the wire.
      this.loadTicket += 1;
      this.olderPromise = null;
      this.host.patch({
        sessionListLoadingOlder: false,
        sessionListOperation: null,
        sessionListError: null,
      });
    }

    const ticket = ++this.curationTicket;
    const ownerKey = this.curationOwnerKey();
    const query = state.sessionQuery;
    const base = this.basePages;
    this.curationPending = false;
    this.curationRequestKey = ownerKey;
    this.retry = null;
    this.host.patch({
      sessionListHydrating: true,
      sessionListOperation: "curation",
      sessionListError: null,
    });
    const ownsRequest = () =>
      ticket === this.curationTicket &&
      ownerKey === this.curationOwnerKey() &&
      query === this.host.state().sessionQuery &&
      api === this.host.api();

    try {
      const hydration = await this.hydrateUnion(
        base,
        this.host.state().prefs,
        ownsRequest,
      );
      if (!hydration || !ownsRequest()) return;
      if (this.basePages !== base) {
        this.curationRequestKey = null;
        return this.hydrateCuration();
      }
      this.hydration = hydration;
      this.curationRequestKey = null;
      this.retry = null;
      this.host.patch({
        sessionListHydrating: false,
        sessionListOperation: null,
        sessionListError: null,
      });
      this.publishUnion();
    } catch (error) {
      if (!ownsRequest()) return;
      this.curationRequestKey = null;
      if (error instanceof ApiError && error.status === 401) {
        this.retry = null;
        this.host.patch({
          sessionListHydrating: false,
          sessionListOperation: null,
          sessionListError: null,
        });
        this.host.handleAuthFailure();
        return;
      }
      this.retry = { kind: "curation", ownerKey };
      this.host.patch({
        sessionListHydrating: false,
        sessionListOperation: "curation",
        sessionListError:
          error instanceof Error
            ? error.message
            : "Failed to load curated sessions",
      });
    }
  }

  private hydrationFailure(
    kind: "session ids" | "curated folders",
    error: unknown,
  ): Error {
    const message =
      error instanceof Error ? error.message : "Unknown hydration failure";
    const label =
      kind === "session ids" ? "active sessions" : "curated folders";
    if (error instanceof ApiError) {
      return new ApiError(
        error.status,
        `Failed to load ${label}: ${message}`,
        error.matches,
      );
    }
    return new Error(`Failed to load ${label}: ${message}`);
  }

  /** Hydration is a separate atomic union. During an optimistic preference
   * write, rows owned by the last confirmed curation survive until the host
   * accepts or rejects the patch. Every request stays inside route caps. */
  private async hydrateUnion(
    base: readonly SessionSummary[],
    prefs: InspirePreferences,
    isCurrent: () => boolean,
  ): Promise<Map<string, SessionSummary> | null> {
    const api = this.host.api();
    if (!api) return new Map();
    if (!isCurrent()) return null;
    const { ids, cwds } = this.hydrationOwners(prefs);
    const baseIds = new Set(base.map((session) => session.id));
    const hydration = new Map<string, SessionSummary>();
    for (const session of this.hydration.values()) {
      if (
        (ids.has(session.id) || cwds.has(session.cwd)) &&
        !baseIds.has(session.id)
      ) {
        hydration.set(session.id, session);
      }
    }

    const missingIds = [...ids].filter(
      (id) => !baseIds.has(id) && !hydration.has(id),
    );
    for (
      let index = 0;
      index < missingIds.length;
      index += MAX_SESSION_ID_HYDRATION_IDS
    ) {
      if (!isCurrent()) return null;
      const chunk = missingIds.slice(
        index,
        index + MAX_SESSION_ID_HYDRATION_IDS,
      );
      try {
        const response = await api.sessionsByIds(chunk);
        if (!isCurrent()) return null;
        for (const session of response.sessions) {
          if (!baseIds.has(session.id)) hydration.set(session.id, session);
        }
      } catch (error) {
        throw this.hydrationFailure("session ids", error);
      }
    }

    const wantedCwds = [...cwds];
    for (
      let index = 0;
      index < wantedCwds.length;
      index += MAX_SESSION_CWD_HYDRATION_CWDS
    ) {
      if (!isCurrent()) return null;
      const chunk = wantedCwds.slice(
        index,
        index + MAX_SESSION_CWD_HYDRATION_CWDS,
      );
      try {
        const response = await api.sessionsByCwds(chunk);
        if (!isCurrent()) return null;
        for (const session of response.sessions) {
          if (!baseIds.has(session.id)) hydration.set(session.id, session);
        }
      } catch (error) {
        throw this.hydrationFailure("curated folders", error);
      }
    }
    return hydration;
  }

  private clearHydrationRetry(): void {
    if (this.retry?.kind === "hydrate") this.retry = null;
  }

  private hydrationOwnerIsCurrent(owner: HydrationOwner): boolean {
    const state = this.host.state();
    const stillOwned =
      state.sessionId === owner.id ||
      Object.hasOwn(state.sessionStatuses, owner.id);
    return (
      stillOwned &&
      !owner.query.trim() &&
      owner.query === state.sessionQuery &&
      owner.ticket === this.loadTicket
    );
  }

  private hydrationRetryMatches(owner: HydrationOwner): boolean {
    const retry = this.retry;
    return (
      retry?.kind === "hydrate" &&
      retry.owner.id === owner.id &&
      retry.owner.query === owner.query &&
      retry.owner.ticket === owner.ticket
    );
  }

  private hydrateVisible(
    owner: HydrationOwner,
    retrying = false,
  ): Promise<void> {
    const api = this.host.api();
    const state = this.host.state();
    if (
      !api ||
      owner.query.trim() ||
      owner.query !== state.sessionQuery ||
      owner.ticket !== this.loadTicket ||
      (retrying && !this.hydrationOwnerIsCurrent(owner))
    ) {
      return Promise.resolve();
    }
    if (
      this.basePages.some((session) => session.id === owner.id) ||
      this.hydration.has(owner.id)
    ) {
      if (this.hydrationRetryMatches(owner)) {
        this.clearHydrationRetry();
        this.host.patch({
          sessionListHydrating: false,
          sessionListOperation: null,
          sessionListError: null,
        });
      }
      return Promise.resolve();
    }
    if (this.hydrationInFlight.has(owner.id)) return Promise.resolve();
    this.hydrationInFlight.add(owner.id);
    if (retrying) {
      this.host.patch({
        sessionListHydrating: true,
        sessionListOperation: "hydrate",
        sessionListError: null,
      });
    }
    const request = (async () => {
      try {
        const { sessions } = await api.sessionsByIds([owner.id]);
        if (!this.hydrationOwnerIsCurrent(owner) || this.host.api() !== api)
          return;
        const session = sessions.find((candidate) => candidate.id === owner.id);
        if (!session)
          throw new Error("Session is not yet available in the catalog");
        if (!this.basePages.some((candidate) => candidate.id === owner.id)) {
          this.hydration.set(owner.id, session);
        }
        const ownsHydrationRetry = this.hydrationRetryMatches(owner);
        if (ownsHydrationRetry) {
          this.clearHydrationRetry();
          this.host.patch({
            sessionListHydrating: false,
            sessionListOperation: null,
            sessionListError: null,
          });
        } else if (retrying) {
          this.host.patch({ sessionListHydrating: false });
        }
        this.publishUnion();
      } catch (error) {
        if (
          !this.hydrationOwnerIsCurrent(owner) ||
          this.host.api() !== api ||
          this.host.state().sessionListLoading ||
          this.host.state().sessionListLoadingOlder
        ) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          this.clearHydrationRetry();
          this.host.patch({
            sessionListHydrating: false,
            sessionListOperation: null,
            sessionListError: null,
          });
          this.host.handleAuthFailure();
          return;
        }
        this.retry = { kind: "hydrate", owner };
        this.host.patch({
          sessionListHydrating: false,
          sessionListOperation: "hydrate",
          sessionListError: this.hydrationFailure("session ids", error).message,
        });
      } finally {
        this.hydrationInFlight.delete(owner.id);
      }
    })();
    return request;
  }

  private owns(ticket: number, query: string, api: Api): boolean {
    return (
      ticket === this.loadTicket &&
      query === this.host.state().sessionQuery &&
      this.host.api() === api
    );
  }
}
