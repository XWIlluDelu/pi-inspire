import type { ProjectDirEntry } from "../../shared/contracts";
import { type Api, ApiError, type ProjectFileResult } from "../api";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";

export interface WorkspaceBrowserState {
  workspaceShowHidden: boolean;
  workspaceTruncatedDirs: Record<string, boolean>;
  workspaceSearchTruncated: boolean;
  workspaceLevels: Record<string, ProjectDirEntry[]>;
  workspaceExpandedDirs: string[];
  workspaceLoadingDirs: string[];
  workspaceDirectoryErrors: Record<string, string>;
  workspaceQuery: string;
  workspaceMatches: ProjectFileResult[];
  workspaceSearchLoading: boolean;
  workspaceSearchError: string | null;
  /** Explicit one-shot request for the full Files tree to locate a path. */
  workspaceRevealRequest: { path: string; nonce: number } | null;
}

export function emptyWorkspaceBrowserState(): WorkspaceBrowserState {
  return {
    workspaceShowHidden: false,
    workspaceTruncatedDirs: {},
    workspaceSearchTruncated: false,
    workspaceLevels: {},
    workspaceExpandedDirs: [],
    workspaceLoadingDirs: [],
    workspaceDirectoryErrors: {},
    workspaceQuery: "",
    workspaceMatches: [],
    workspaceSearchLoading: false,
    workspaceSearchError: null,
    workspaceRevealRequest: null,
  };
}

interface WorkspaceOwnerState extends WorkspaceBrowserState {
  sessionId: string | null;
  cwd: string | null;
}

interface WorkspaceControllerHost {
  state(): WorkspaceOwnerState;
  patch(patch: Partial<WorkspaceBrowserState>): void;
  api(): Api | null;
  transportGeneration(): number;
  handleAuthFailure(): void;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function parentsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    parents.push(parts.slice(0, index).join("/"));
  return parents;
}

/**
 * Owns the workspace tree/search projection rendered by the Files browser.
 * Requests are bound to the active transport, session, and cwd so a late
 * response cannot refill another workspace.
 */
export class WorkspaceController {
  private directoryRequests = new Map<string, AbortController>();
  private searchRequest: AbortController | null = null;
  private directoryRecoveries = new Map<string, RecoveryBackoff>();
  private searchRecovery = new RecoveryBackoff();
  private refreshGeneration = 0;
  private revealNonce = 0;
  private statesByCwd = new Map<string, WorkspaceBrowserState>();

  constructor(private readonly host: WorkspaceControllerHost) {}

  private owns(
    api: Api,
    transportGeneration: number,
    sessionId: string,
    cwd: string,
  ): boolean {
    const state = this.host.state();
    return (
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration &&
      state.sessionId === sessionId &&
      state.cwd === cwd
    );
  }

  cancelRequests(): void {
    this.refreshGeneration += 1;
    for (const request of this.directoryRequests.values()) request.abort();
    this.directoryRequests.clear();
    for (const recovery of this.directoryRecoveries.values()) recovery.reset();
    this.directoryRecoveries.clear();
    this.searchRecovery.reset();
    this.searchRequest?.abort();
    this.searchRequest = null;
  }

  changeOwner(nextCwd: string | null): WorkspaceBrowserState {
    const current = this.host.state();
    // Touch the destination before saving the departing workspace. Otherwise,
    // inserting into a full LRU can evict the very projection being restored.
    if (nextCwd && nextCwd !== current.cwd) {
      const destination = this.statesByCwd.get(nextCwd);
      if (destination) {
        this.statesByCwd.delete(nextCwd);
        this.statesByCwd.set(nextCwd, destination);
      }
    }
    if (current.cwd) {
      const cached: WorkspaceBrowserState = {
        workspaceShowHidden: current.workspaceShowHidden,
        workspaceTruncatedDirs: { ...current.workspaceTruncatedDirs },
        workspaceSearchTruncated: current.workspaceSearchTruncated,
        workspaceLevels: { ...current.workspaceLevels },
        workspaceExpandedDirs: [...current.workspaceExpandedDirs],
        workspaceLoadingDirs: [],
        workspaceDirectoryErrors: { ...current.workspaceDirectoryErrors },
        workspaceQuery: current.workspaceQuery,
        workspaceMatches: [...current.workspaceMatches],
        workspaceSearchLoading: current.workspaceSearchLoading,
        workspaceSearchError: current.workspaceSearchError,
        workspaceRevealRequest: null,
      };
      this.statesByCwd.delete(current.cwd);
      this.statesByCwd.set(current.cwd, cached);
      while (this.statesByCwd.size > 8) {
        const oldest = this.statesByCwd.keys().next().value as
          | string
          | undefined;
        if (!oldest) break;
        this.statesByCwd.delete(oldest);
      }
    }
    this.cancelRequests();
    if (!nextCwd) return emptyWorkspaceBrowserState();
    const cached = this.statesByCwd.get(nextCwd);
    if (!cached) return emptyWorkspaceBrowserState();
    this.statesByCwd.delete(nextCwd);
    this.statesByCwd.set(nextCwd, cached);
    return {
      ...cached,
      workspaceLevels: { ...cached.workspaceLevels },
      workspaceExpandedDirs: [...cached.workspaceExpandedDirs],
      workspaceLoadingDirs: [],
      workspaceDirectoryErrors: { ...cached.workspaceDirectoryErrors },
      workspaceMatches: [...cached.workspaceMatches],
    };
  }

  resumeSearch(): void {
    const state = this.host.state();
    if (
      state.sessionId &&
      state.cwd &&
      state.workspaceQuery.trim() &&
      (state.workspaceSearchLoading || state.workspaceSearchError) &&
      !this.searchRequest
    )
      void this.search(state.workspaceQuery);
  }

  invalidateForTransportReplacement(): void {
    this.cancelRequests();
    this.statesByCwd.clear();
    const state = this.host.state();
    this.host.patch({
      ...emptyWorkspaceBrowserState(),
      // Navigation belongs to the browser; fetched rows belong to the retired
      // transport. Keep intent available to gestures made during bootstrap.
      workspaceShowHidden: state.workspaceShowHidden,
      workspaceExpandedDirs: state.workspaceExpandedDirs,
      workspaceQuery: state.workspaceQuery,
      workspaceSearchLoading: Boolean(state.workspaceQuery.trim()),
    });
  }

  async loadDirectory(
    dir: string,
    options: { refresh?: boolean } = {},
  ): Promise<void> {
    const api = this.host.api();
    const { sessionId, cwd, workspaceLevels } = this.host.state();
    if (
      !api ||
      !sessionId ||
      !cwd ||
      this.directoryRequests.has(dir) ||
      (!options.refresh &&
        Object.prototype.hasOwnProperty.call(workspaceLevels, dir) &&
        !this.host.state().workspaceDirectoryErrors[dir])
    )
      return;
    const request = new AbortController();
    const transportGeneration = this.host.transportGeneration();
    this.directoryRequests.set(dir, request);
    const recovery = new RecoveryBackoff();
    this.directoryRecoveries.set(dir, recovery);
    const currentRequest = () =>
      this.directoryRequests.get(dir) === request &&
      !request.signal.aborted &&
      this.owns(api, transportGeneration, sessionId, cwd);
    const before = this.host.state();
    this.host.patch({
      workspaceLoadingDirs: [...new Set([...before.workspaceLoadingDirs, dir])],
      workspaceDirectoryErrors: Object.fromEntries(
        Object.entries(before.workspaceDirectoryErrors).filter(
          ([path]) => path !== dir,
        ),
      ),
    });
    try {
      let response;
      while (true) {
        try {
          response = await api.listFiles(sessionId, dir, {
            signal: request.signal,
            refresh: options.refresh,
            showHidden: before.workspaceShowHidden,
          });
          break;
        } catch (error) {
          if (!currentRequest()) return;
          if (
            !isTransientFailure(error) ||
            !(await recovery.wait(request.signal))
          )
            throw error;
          if (!currentRequest()) return;
        }
      }
      if (!currentRequest()) return;
      const current = this.host.state();
      this.host.patch({
        workspaceLevels: {
          ...current.workspaceLevels,
          [dir]: response.entries,
        },
        workspaceTruncatedDirs: {
          ...current.workspaceTruncatedDirs,
          [dir]: Boolean(response.truncated),
        },
        workspaceDirectoryErrors: Object.fromEntries(
          Object.entries(current.workspaceDirectoryErrors).filter(
            ([path]) => path !== dir,
          ),
        ),
      });
    } catch (error) {
      if (!currentRequest()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      const current = this.host.state();
      this.host.patch({
        workspaceDirectoryErrors: {
          ...current.workspaceDirectoryErrors,
          [dir]: messageOf(error, "Directory unavailable"),
        },
      });
    } finally {
      if (this.directoryRequests.get(dir) === request) {
        this.directoryRequests.delete(dir);
        recovery.reset();
        this.directoryRecoveries.delete(dir);
        const current = this.host.state();
        this.host.patch({
          workspaceLoadingDirs: current.workspaceLoadingDirs.filter(
            (path) => path !== dir,
          ),
        });
      }
    }
  }

  toggleDirectory(dir: string): void {
    const state = this.host.state();
    const expanded = new Set(state.workspaceExpandedDirs);
    if (expanded.has(dir)) expanded.delete(dir);
    else {
      expanded.add(dir);
      if (!Object.prototype.hasOwnProperty.call(state.workspaceLevels, dir))
        void this.loadDirectory(dir);
    }
    this.host.patch({ workspaceExpandedDirs: [...expanded] });
  }

  revealPath(path: string): void {
    const parents = parentsOf(path);
    const state = this.host.state();
    const expanded = new Set(state.workspaceExpandedDirs);
    for (const parent of parents) expanded.add(parent);
    this.host.patch({
      workspaceExpandedDirs: [...expanded],
      workspaceRevealRequest: { path, nonce: ++this.revealNonce },
    });
    for (const dir of ["", ...parents]) {
      if (!Object.prototype.hasOwnProperty.call(state.workspaceLevels, dir))
        void this.loadDirectory(dir);
    }
  }

  consumeRevealRequest(nonce: number): boolean {
    if (this.host.state().workspaceRevealRequest?.nonce !== nonce) return false;
    this.host.patch({ workspaceRevealRequest: null });
    return true;
  }

  setShowHidden(showHidden: boolean): void {
    if (showHidden === this.host.state().workspaceShowHidden) return;
    const state = this.host.state();
    this.cancelRequests();
    // A visibility change is a different projection, not an in-place refresh.
    this.host.patch({
      ...emptyWorkspaceBrowserState(),
      workspaceShowHidden: showHidden,
      workspaceExpandedDirs: state.workspaceExpandedDirs,
      workspaceQuery: state.workspaceQuery,
    });
    void this.refresh();
  }

  setQuery(query: string): void {
    this.searchRequest?.abort();
    this.searchRequest = null;
    this.searchRecovery.reset();
    const state = this.host.state();
    const sameQuery = state.workspaceQuery === query;
    this.host.patch({
      workspaceQuery: query,
      workspaceMatches: sameQuery ? state.workspaceMatches : [],
      workspaceSearchTruncated: sameQuery && state.workspaceSearchTruncated,
      workspaceSearchLoading: Boolean(query.trim()),
      workspaceSearchError: null,
    });
    if (query.trim()) void this.search(query);
  }

  private async search(query: string): Promise<void> {
    const api = this.host.api();
    const { sessionId, cwd } = this.host.state();
    if (!api || !sessionId || !cwd) return;
    const request = new AbortController();
    const transportGeneration = this.host.transportGeneration();
    this.searchRequest = request;
    this.searchRecovery.reset();
    const showHidden = this.host.state().workspaceShowHidden;
    const ownsQuery = () =>
      this.searchRequest === request &&
      !request.signal.aborted &&
      this.owns(api, transportGeneration, sessionId, cwd) &&
      this.host.state().workspaceQuery === query;
    this.host.patch({
      workspaceSearchLoading: true,
      workspaceSearchError: null,
    });
    try {
      let response;
      while (true) {
        try {
          response = await api.searchFiles(
            sessionId,
            query,
            100,
            request.signal,
            showHidden,
          );
          break;
        } catch (error) {
          if (!ownsQuery()) return;
          if (
            !isTransientFailure(error) ||
            !(await this.searchRecovery.wait(request.signal))
          )
            throw error;
          if (!ownsQuery()) return;
        }
      }
      if (!ownsQuery()) return;
      this.host.patch({
        workspaceMatches: response.files,
        workspaceSearchTruncated: Boolean(response.truncated),
        workspaceSearchLoading: false,
        workspaceSearchError: null,
      });
    } catch (error) {
      if (!ownsQuery()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      this.host.patch({
        workspaceSearchLoading: false,
        workspaceSearchError: messageOf(error, "Workspace search failed"),
      });
    } finally {
      if (this.searchRequest === request) {
        this.searchRequest = null;
        this.searchRecovery.reset();
      }
    }
  }

  async refresh(): Promise<void> {
    const state = this.host.state();
    const expanded = [...state.workspaceExpandedDirs];
    const query = state.workspaceQuery;
    this.cancelRequests();
    const generation = this.refreshGeneration;
    this.host.patch({
      workspaceLoadingDirs: [],
      workspaceDirectoryErrors: {},
      workspaceSearchError: null,
      workspaceSearchLoading: Boolean(query.trim()),
    });
    await this.loadDirectory("", { refresh: true });
    if (generation !== this.refreshGeneration) return;
    await Promise.all(
      expanded.map((dir) => this.loadDirectory(dir, { refresh: true })),
    );
    if (
      generation === this.refreshGeneration &&
      query.trim() &&
      this.host.state().workspaceQuery === query
    )
      await this.search(query);
  }
}
