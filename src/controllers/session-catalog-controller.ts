import {
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type SessionListResponse,
  type SessionSummary,
} from "../../shared/contracts";
import type { AppState } from "../app-state";
import { type Api, ApiError } from "../api";
import {
  isTransientFailure,
  RecoveryBackoff,
  readScope,
} from "../recovery-backoff";
import { sessionCurationOwners } from "../session-curation";

const SESSION_PAGE_SIZE = 40;

type SessionListOperation = AppState["sessionListOperation"];

function listFeedback(
  operation: SessionListOperation = null,
  error: string | null = null,
) {
  return {
    sessionListLoading:
      error === null && (operation === "reset" || operation === "refresh"),
    sessionListLoadingOlder: error === null && operation === "older",
    sessionListOperation: operation,
    sessionListError: error,
  };
}

type Owners = ReturnType<typeof sessionCurationOwners>;
type ReadScope = ReturnType<typeof readScope>;
type ListAction =
  | { kind: "reset" | "refresh" }
  | { kind: "older"; offset: number }
  | { kind: "preserve"; offset: number; total: number; foreground: boolean };
type ListRead = { scope: ReadScope; action: ListAction; task?: Promise<void> };

interface SessionCatalogControllerHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  handleAuthFailure(): void;
}

/**
 * Owns chronological session pagination, curation/live hydration, retry state,
 * and its query-scoped request generations. The host remains the only public
 * snapshot authority; this controller never owns selection or a second session
 * catalog projection.
 */
export class SessionCatalogController {
  private readonly basePages = new Map<string, SessionSummary>();
  private readonly hydration = new Map<string, SessionSummary>();
  private list: ListRead | null = null;
  private curation: { scope: ReadScope; owners: Owners } | null = null;
  private retry: ListAction | null = null;
  private readonly visibleReads = new Map<string, ReadScope>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SessionCatalogControllerHost) {}

  private retireQuery(): void {
    this.cancelList();
    for (const id of this.visibleReads.keys()) this.retireVisibleRead(id);
    this.cancelCurationRequest();
  }

  private cancelList(): void {
    this.list?.scope.abort();
    this.list = null;
    this.retry = null;
  }

  /** Invalidates all owned work when bootstrap/auth changes the API client.
   * Confirmed rows stay visible, but a former transport cannot publish over the
   * current generation or turn a later successful pairing into a 401. */
  invalidate(): void {
    this.clearSearchTimer();
    this.retireQuery();
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
      ...listFeedback(),
      sessionListHydrating: false,
    });
  }

  load(query: string): Promise<void> {
    this.clearSearchTimer();
    return this.startList(query, { kind: "reset" });
  }

  /** Search changes query ownership synchronously, then issues its debounced
   * reset. Old-query pages cannot remain rendered or win while typing. */
  search(query: string): void {
    this.retireQuery();
    this.host.patch({
      ...this.resetRows(query),
      ...listFeedback("reset"),
      sessionListHydrating: false,
    });
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => void this.load(query), 180);
  }

  private resetRows(query: string) {
    this.basePages.clear();
    return {
      sessionQuery: query,
      sessions: query.trim() ? [] : [...this.hydration.values()],
      sessionListTotal: 0,
      sessionListNextOffset: 0,
    };
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

  /** Rebuild the consumed extent after a catalog change. */
  preserve(query: string, offset: number, total: number): Promise<void> {
    const state = this.host.state();
    if (query !== state.sessionQuery) return Promise.resolve();
    // A background hint cannot supersede an explicit refresh command.
    if (this.list?.action.kind === "refresh" && this.list.task)
      return this.list.task;
    return this.startList(query, {
      kind: "preserve",
      offset,
      total,
      foreground: state.sessionListLoading,
    });
  }

  loadOlder(): Promise<void> {
    if (this.list?.action.kind === "older" && this.list.task)
      return this.list.task;
    const state = this.host.state();
    if (
      state.sessionListLoading ||
      state.sessionListNextOffset >= state.sessionListTotal
    )
      return Promise.resolve();
    return this.startList(state.sessionQuery, {
      kind: "older",
      offset: state.sessionListNextOffset,
    });
  }

  refresh(query = this.host.state().sessionQuery): Promise<void> {
    return query === this.host.state().sessionQuery
      ? this.startList(query, { kind: "refresh" })
      : Promise.resolve();
  }

  retryCurrent(): Promise<void> {
    this.clearSearchTimer();
    const state = this.host.state();
    return this.retry?.kind === "older"
      ? this.loadOlder()
      : this.startList(state.sessionQuery, this.retry ?? { kind: "reset" });
  }

  /** Hydrated rows never advance the chronological cursor. */
  ensureVisible(id: string): void {
    void this.hydrateVisible(id);
  }

  remove(ids: ReadonlySet<string>): void {
    this.cancelCurationRequest();
    for (const id of ids) {
      this.basePages.delete(id);
      this.hydration.delete(id);
      this.retireVisibleRead(id);
    }
    this.publishUnion({ sessionListHydrating: false });
  }

  private startList(query: string, action: ListAction): Promise<void> {
    const api = this.host.api();
    if (!api) return Promise.resolve();
    const queryChanged = query !== this.host.state().sessionQuery;
    const append = action.kind === "older";
    if (append) this.cancelList();
    else this.retireQuery();

    const scope = readScope(
      () => this.host.api() === api && this.host.state().sessionQuery === query,
    );
    const operation =
      action.kind === "preserve"
        ? action.foreground
          ? "reset"
          : null
        : action.kind;
    const read: ListRead = { scope, action };
    this.list = read;
    this.host.patch({
      ...(queryChanged ? this.resetRows(query) : {}),
      ...(!append ? { sessionListHydrating: false } : {}),
      ...listFeedback(operation),
    });
    read.task = this.readList(api, scope, query, action, operation).finally(
      () => {
        if (this.list === read) this.list = null;
      },
    );
    return read.task;
  }

  private async readList(
    api: Api,
    scope: ReadScope,
    query: string,
    action: ListAction,
    operation: SessionListOperation,
  ): Promise<void> {
    const append = action.kind === "older";
    let retry: ListAction =
      action.kind === "preserve" ? { kind: "reset" } : action;
    try {
      if (action.kind === "refresh") {
        scope.check();
        await api.json("refreshSessions", {});
        retry = { kind: "reset" };
      }
      const perform = (signal: AbortSignal) =>
        this.readPages(api, signal, query, action);
      const page = await scope.read(
        perform,
        operation === null ? new RecoveryBackoff() : undefined,
      );
      if (!append) this.basePages.clear();
      for (const session of page.sessions)
        if (!this.basePages.has(session.id))
          this.basePages.set(session.id, session);
      this.pruneHydration();
      this.publishUnion({
        ...listFeedback(),
        sessionListTotal: page.total,
        sessionListNextOffset: page.nextOffset,
      });
      // Supplemental discovery must never hold back a confirmed base page.
      if (!append && !query.trim() && scope.current())
        void this.hydrateCuration();
    } catch (error) {
      if (!scope.current()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.patch(listFeedback());
        this.host.handleAuthFailure();
        return;
      }
      if (operation !== null) {
        this.retry = retry;
        this.host.patch(
          listFeedback(
            retry.kind,
            error instanceof Error ? error.message : "Failed to list sessions",
          ),
        );
      }
    }
  }

  private async readPages(
    api: Api,
    signal: AbortSignal,
    query: string,
    action: ListAction,
  ) {
    const sessions: SessionSummary[] = [];
    const preserve = action.kind === "preserve" ? action : null;
    let nextOffset = action.kind === "older" ? action.offset : 0;
    let target = preserve?.offset ?? 0;
    let page: SessionListResponse;
    do {
      signal.throwIfAborted();
      const limit =
        target > nextOffset
          ? Math.min(MAX_SESSION_LIST_PAGE_SIZE, target - nextOffset)
          : SESSION_PAGE_SIZE;
      page = await api.json(
        "sessions",
        { query: { q: query, offset: nextOffset, limit } },
        signal,
      );
      if (
        page.offset !== nextOffset ||
        (!page.sessions.length && nextOffset < page.total)
      )
        throw new Error(
          "Session paging did not advance from its requested offset",
        );
      if (!sessions.length && preserve && target > 0)
        target = Math.min(
          page.total,
          target + Math.max(0, page.total - preserve.total),
        );
      sessions.push(...page.sessions);
      nextOffset += page.sessions.length;
    } while (nextOffset < target && nextOffset < page.total);
    return {
      sessions,
      nextOffset,
      total: page.total,
    };
  }

  private publishUnion(patch: Partial<AppState> = {}): void {
    const sessions = [...this.basePages.values()];
    if (!this.host.state().sessionQuery.trim())
      for (const [id, row] of this.hydration)
        if (!this.basePages.has(id)) sessions.push(row);
    this.host.patch({ ...patch, sessions });
  }

  private hydrationOwners() {
    const { ids, cwds } = sessionCurationOwners(this.host.state().prefs);
    for (const id of this.liveSessionIds()) ids.add(id);
    return { ids, cwds };
  }

  private liveSessionIds(): Set<string> {
    const { sessionId, sessionStatuses, externalSessionActivities } =
      this.host.state();
    return new Set([
      ...(sessionId ? [sessionId] : []),
      ...Object.keys(sessionStatuses),
      ...Object.keys(externalSessionActivities),
    ]);
  }

  private hasSession(id: string): boolean {
    return this.basePages.has(id) || this.hydration.has(id);
  }

  private retireVisibleRead(id: string): void {
    const read = this.visibleReads.get(id);
    this.visibleReads.delete(id);
    read?.abort();
  }

  private cancelCurationRequest(): void {
    this.curation?.scope.abort();
    this.curation = null;
  }

  private pruneHydration({ ids, cwds } = this.hydrationOwners()): boolean {
    let changed = false;
    for (const [id, session] of this.hydration) {
      if (!this.basePages.has(id) && (ids.has(id) || cwds.has(session.cwd)))
        continue;
      this.hydration.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Reclassify already-known rows after confirmed curation changes. */
  reconcileCuration(added: Owners): void {
    const liveIds = this.liveSessionIds();
    for (const id of this.visibleReads.keys())
      if (!liveIds.has(id) || this.hasSession(id)) this.retireVisibleRead(id);
    const current = this.hydrationOwners();
    if (this.pruneHydration(current)) this.publishUnion();
    for (const id of added.ids) if (this.hasSession(id)) added.ids.delete(id);
    if (this.curation) {
      // An interrupted batch has published none of its rows yet.
      for (const id of this.curation.owners.ids)
        if (current.ids.has(id)) added.ids.add(id);
      for (const cwd of this.curation.owners.cwds)
        if (current.cwds.has(cwd)) added.cwds.add(cwd);
    }
    void this.hydrateCuration(added);
  }

  private async hydrateCuration(
    owners = this.hydrationOwners(),
  ): Promise<void> {
    this.cancelCurationRequest();
    const api = this.host.api();
    const query = this.host.state().sessionQuery;
    if (!api || query.trim()) return;
    for (const id of owners.ids)
      if (this.basePages.has(id)) owners.ids.delete(id);
    if (!owners.ids.size && !owners.cwds.size) {
      if (this.host.state().sessionListHydrating)
        this.host.patch({ sessionListHydrating: false });
      return;
    }
    const scope = readScope(
      () => this.host.api() === api && this.host.state().sessionQuery === query,
    );
    this.curation = { scope, owners };
    const retainedIds = this.hydrationOwners().ids;
    const reviewed = [...this.hydration].filter(
      ([id, row]) =>
        owners.ids.has(id) ||
        (!retainedIds.has(id) && owners.cwds.has(row.cwd)),
    );
    this.host.patch({ sessionListHydrating: true });
    try {
      const hydration = await scope.read(
        (signal) => this.readSupplementalRows(api, signal, owners),
        new RecoveryBackoff(),
      );
      // Replace the reviewed rows together. A live lookup that finished
      // independently during this read can have added a new identity.
      for (const [id] of reviewed)
        if (!hydration.has(id)) this.hydration.delete(id);
      for (const [id, session] of hydration) this.hydration.set(id, session);
      this.pruneHydration();
      this.publishUnion();
      for (const id of this.liveSessionIds())
        void this.hydrateVisible(id, true);
    } catch (error) {
      if (scope.current() && error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
    } finally {
      if (this.curation?.scope === scope) {
        this.curation = null;
        this.host.patch({ sessionListHydrating: false });
      }
    }
  }

  private async readSupplementalRows(
    api: Api,
    signal: AbortSignal,
    { ids, cwds }: Owners,
  ): Promise<Map<string, SessionSummary>> {
    const hydration = new Map<string, SessionSummary>();
    const reads = [
      {
        field: "id",
        owners: [...ids],
        limit: MAX_SESSION_ID_HYDRATION_IDS,
        read: (chunk: string[]) =>
          api.json("sessionsByIds", { body: { ids: chunk } }, signal),
      },
      {
        field: "cwd",
        owners: [...cwds],
        limit: MAX_SESSION_CWD_HYDRATION_CWDS,
        read: (chunk: string[]) =>
          api.json("sessionsByCwds", { body: { cwds: chunk } }, signal),
      },
    ] as const;
    for (const { field, owners, limit, read } of reads) {
      for (let index = 0; index < owners.length; index += limit) {
        signal.throwIfAborted();
        const chunk = owners.slice(index, index + limit);
        const response = await read(chunk);
        signal.throwIfAborted();
        const requested = new Set(chunk);
        for (const session of response.sessions) {
          if (requested.has(session[field]) && !this.basePages.has(session.id))
            hydration.set(session.id, session);
        }
      }
    }
    return hydration;
  }

  private async hydrateVisible(id: string, delayed = false): Promise<void> {
    const api = this.host.api();
    if (
      !api ||
      this.host.state().sessionQuery.trim() ||
      this.visibleReads.has(id) ||
      this.hasSession(id)
    )
      return;

    const recovery = new RecoveryBackoff();
    const request = readScope(() => {
      const { sessionId, sessionStatuses, externalSessionActivities } =
        this.host.state();
      return (
        this.host.api() === api &&
        (sessionId === id ||
          Object.hasOwn(sessionStatuses, id) ||
          Object.hasOwn(externalSessionActivities, id))
      );
    });
    this.visibleReads.set(id, request);
    const { signal, current } = request;

    try {
      if (delayed && !(await recovery.wait(signal))) return;
      while (current() && !this.hasSession(id)) {
        try {
          const { sessions } = await request.read((signal) =>
            api.json("sessionsByIds", { body: { ids: [id] } }, signal),
          );
          if (this.hasSession(id)) return;
          const session = sessions.find((row) => row.id === id);
          if (session) {
            this.hydration.set(id, session);
            this.publishUnion();
            return;
          }
          // A new Pi session may not have written its catalog row yet.
        } catch (error) {
          if (!current() || this.hasSession(id)) return;
          if (error instanceof ApiError && error.status === 401) {
            this.host.handleAuthFailure();
            return;
          }
          if (!isTransientFailure(error)) return;
        }
        if (!(await recovery.wait(signal))) break;
      }
    } finally {
      // An absent row keeps its spent budget across further streaming events.
      // A catalog refresh or a new query gives it a fresh observation.
      if (
        this.visibleReads.get(id) === request &&
        (!current() || this.hasSession(id))
      )
        this.retireVisibleRead(id);
    }
  }

  private clearSearchTimer(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }
}
