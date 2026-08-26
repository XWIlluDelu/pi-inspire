import type { ProjectDirEntry } from "../../shared/contracts";
import { type Api, ApiError, type ProjectFileResult } from "../api";

export interface WorkspaceBrowserState {
  workspaceLevels: Record<string, ProjectDirEntry[]>;
  workspaceExpandedDirs: string[];
  workspaceLoadingDirs: string[];
  workspaceDirectoryErrors: Record<string, string>;
  workspaceQuery: string;
  workspaceMatches: ProjectFileResult[];
  workspaceSearchLoading: boolean;
  workspaceSearchError: string | null;
}

export function emptyWorkspaceBrowserState(): WorkspaceBrowserState {
  return {
    workspaceLevels: {},
    workspaceExpandedDirs: [],
    workspaceLoadingDirs: [],
    workspaceDirectoryErrors: {},
    workspaceQuery: "",
    workspaceMatches: [],
    workspaceSearchLoading: false,
    workspaceSearchError: null,
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
 * Owns the single workspace tree/search projection rendered by both the
 * compact navigation explorer and the full Files browser. Requests are bound
 * to the active transport, session, and cwd so a late response cannot refill
 * another workspace.
 */
export class WorkspaceController {
  private directoryRequests = new Map<string, AbortController>();
  private searchRequest: AbortController | null = null;
  private refreshGeneration = 0;
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
        workspaceLevels: { ...current.workspaceLevels },
        workspaceExpandedDirs: [...current.workspaceExpandedDirs],
        workspaceLoadingDirs: [],
        workspaceDirectoryErrors: { ...current.workspaceDirectoryErrors },
        workspaceQuery: current.workspaceQuery,
        workspaceMatches: [...current.workspaceMatches],
        workspaceSearchLoading: current.workspaceSearchLoading,
        workspaceSearchError: current.workspaceSearchError,
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
      state.workspaceSearchLoading &&
      !this.searchRequest
    )
      void this.search(state.workspaceQuery);
  }

  invalidateForTransportReplacement(): void {
    this.cancelRequests();
    this.statesByCwd.clear();
    this.host.patch(emptyWorkspaceBrowserState());
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
        Object.prototype.hasOwnProperty.call(workspaceLevels, dir))
    )
      return;
    const request = new AbortController();
    const transportGeneration = this.host.transportGeneration();
    this.directoryRequests.set(dir, request);
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
      const response = await api.listFiles(sessionId, dir, {
        signal: request.signal,
        refresh: options.refresh,
      });
      if (
        this.directoryRequests.get(dir) !== request ||
        request.signal.aborted ||
        !this.owns(api, transportGeneration, sessionId, cwd)
      )
        return;
      const current = this.host.state();
      this.host.patch({
        workspaceLevels: {
          ...current.workspaceLevels,
          [dir]: response.entries,
        },
        workspaceDirectoryErrors: Object.fromEntries(
          Object.entries(current.workspaceDirectoryErrors).filter(
            ([path]) => path !== dir,
          ),
        ),
      });
    } catch (error) {
      if (
        this.directoryRequests.get(dir) !== request ||
        request.signal.aborted ||
        !this.owns(api, transportGeneration, sessionId, cwd)
      )
        return;
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
    this.host.patch({ workspaceExpandedDirs: [...expanded] });
    for (const dir of ["", ...parents]) {
      if (!Object.prototype.hasOwnProperty.call(state.workspaceLevels, dir))
        void this.loadDirectory(dir);
    }
  }

  setQuery(query: string): void {
    this.searchRequest?.abort();
    this.searchRequest = null;
    this.host.patch({
      workspaceQuery: query,
      workspaceMatches: [],
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
    try {
      const response = await api.searchFiles(
        sessionId,
        query,
        100,
        request.signal,
      );
      const current = this.host.state();
      if (
        this.searchRequest !== request ||
        request.signal.aborted ||
        !this.owns(api, transportGeneration, sessionId, cwd) ||
        current.workspaceQuery !== query
      )
        return;
      this.host.patch({
        workspaceMatches: response.files,
        workspaceSearchLoading: false,
        workspaceSearchError: null,
      });
    } catch (error) {
      const current = this.host.state();
      if (
        this.searchRequest !== request ||
        request.signal.aborted ||
        !this.owns(api, transportGeneration, sessionId, cwd) ||
        current.workspaceQuery !== query
      )
        return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      this.host.patch({
        workspaceMatches: [],
        workspaceSearchLoading: false,
        workspaceSearchError: messageOf(error, "Workspace search failed"),
      });
    } finally {
      if (this.searchRequest === request) this.searchRequest = null;
    }
  }

  async refresh(): Promise<void> {
    const state = this.host.state();
    const expanded = [...state.workspaceExpandedDirs];
    const query = state.workspaceQuery;
    this.cancelRequests();
    const generation = this.refreshGeneration;
    this.host.patch({
      ...emptyWorkspaceBrowserState(),
      workspaceExpandedDirs: expanded,
      workspaceQuery: query,
      workspaceSearchLoading: Boolean(query.trim()),
    });
    await this.loadDirectory("", { refresh: true });
    if (generation !== this.refreshGeneration) return;
    await Promise.all(expanded.map((dir) => this.loadDirectory(dir)));
    if (
      generation === this.refreshGeneration &&
      query.trim() &&
      this.host.state().workspaceQuery === query
    )
      await this.search(query);
  }
}
