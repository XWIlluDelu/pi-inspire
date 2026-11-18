import type { ProjectDirEntry } from "../../shared/contracts";
import { type Api, ApiError, type ProjectFileResult } from "../api";
import { recoverableRead } from "../recovery-backoff";

interface DirectoryLevel {
  entries?: ProjectDirEntry[];
  truncated?: boolean;
  error?: string;
}

export interface WorkspaceBrowserState {
  workspaceShowHidden: boolean;
  workspaceSearchTruncated: boolean;
  workspaceLevels: ReadonlyMap<string, DirectoryLevel>;
  workspaceExpandedDirs: string[];
  workspaceDirectoryLoading: boolean;
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
    workspaceSearchTruncated: false,
    workspaceLevels: new Map(),
    workspaceExpandedDirs: [],
    workspaceDirectoryLoading: false,
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
  private directoryRequests = new Map<
    string,
    ReturnType<typeof recoverableRead>
  >();
  private searchRequest: ReturnType<typeof recoverableRead> | null = null;
  private refreshGeneration = 0;
  private revealNonce = 0;
  private statesByCwd = new Map<string, WorkspaceBrowserState>();

  constructor(private readonly host: WorkspaceControllerHost) {}

  private owns(api: Api, sessionId: string, cwd: string): boolean {
    const state = this.host.state();
    return (
      this.host.api() === api &&
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
    if (current.cwd) {
      this.statesByCwd.delete(current.cwd);
      // Browser projections are replaced on update, so cached rows can share
      // the confirmed snapshot without copying it on both sides of a switch.
      this.statesByCwd.set(current.cwd, {
        workspaceShowHidden: current.workspaceShowHidden,
        workspaceSearchTruncated: current.workspaceSearchTruncated,
        workspaceLevels: current.workspaceLevels,
        workspaceExpandedDirs: current.workspaceExpandedDirs,
        workspaceDirectoryLoading: false,
        workspaceQuery: current.workspaceQuery,
        workspaceMatches: current.workspaceMatches,
        workspaceSearchLoading: current.workspaceSearchLoading,
        workspaceSearchError: current.workspaceSearchError,
        workspaceRevealRequest: null,
      });
    }
    this.cancelRequests();
    const cached = nextCwd ? this.statesByCwd.get(nextCwd) : undefined;
    // Promote the destination before enforcing the cache limit.
    if (nextCwd && cached) {
      this.statesByCwd.delete(nextCwd);
      this.statesByCwd.set(nextCwd, cached);
    }
    if (this.statesByCwd.size > 8)
      this.statesByCwd.delete(this.statesByCwd.keys().next().value!);
    return cached ?? emptyWorkspaceBrowserState();
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
    this.statesByCwd.clear();
    this.resetProjection(this.host.state().workspaceShowHidden);
  }

  private resetProjection(showHidden: boolean): void {
    this.cancelRequests();
    const { workspaceExpandedDirs, workspaceQuery } = this.host.state();
    this.host.patch({
      ...emptyWorkspaceBrowserState(),
      workspaceShowHidden: showHidden,
      workspaceExpandedDirs,
      workspaceQuery,
      workspaceSearchLoading: Boolean(workspaceQuery.trim()),
    });
  }

  async loadDirectory(
    dir: string,
    options: { refresh?: boolean } = {},
  ): Promise<void> {
    const api = this.host.api();
    const before = this.host.state();
    const { sessionId, cwd, workspaceLevels } = before;
    const previous = workspaceLevels.get(dir);
    if (
      !api ||
      !sessionId ||
      !cwd ||
      this.directoryRequests.has(dir) ||
      (!options.refresh && previous?.entries && !previous.error)
    )
      return;
    const request = recoverableRead(() => this.owns(api, sessionId, cwd));
    this.directoryRequests.set(dir, request);
    if (!before.workspaceDirectoryLoading)
      this.host.patch({ workspaceDirectoryLoading: true });
    let level: DirectoryLevel | undefined;
    try {
      level = await request.read((signal) =>
        api.json(
          "listFiles",
          {
            query: {
              sessionId,
              dir,
              refresh: options.refresh ? "1" : undefined,
              showHidden: before.workspaceShowHidden ? "1" : undefined,
            },
          },
          signal,
        ),
      );
    } catch (error) {
      if (!request.current()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      level = { ...previous, error: messageOf(error, "Directory unavailable") };
    } finally {
      if (this.directoryRequests.get(dir) === request) {
        this.directoryRequests.delete(dir);
        let levels = this.host.state().workspaceLevels;
        if (level && request.current())
          levels = new Map(levels).set(dir, level);
        this.host.patch({
          workspaceLevels: levels,
          workspaceDirectoryLoading: this.directoryRequests.size > 0,
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
  }

  consumeRevealRequest(nonce: number): boolean {
    if (this.host.state().workspaceRevealRequest?.nonce !== nonce) return false;
    this.host.patch({ workspaceRevealRequest: null });
    return true;
  }

  setShowHidden(showHidden: boolean): void {
    if (showHidden === this.host.state().workspaceShowHidden) return;
    this.resetProjection(showHidden);
    void this.refresh();
  }

  setQuery(query: string): void {
    this.searchRequest?.abort();
    this.searchRequest = null;
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
    this.searchRequest?.abort();
    const showHidden = this.host.state().workspaceShowHidden;
    const request = recoverableRead(
      () =>
        this.owns(api, sessionId, cwd) &&
        this.host.state().workspaceQuery === query,
    );
    this.searchRequest = request;
    this.host.patch({
      workspaceSearchLoading: true,
      workspaceSearchError: null,
    });
    try {
      const response = await request.read((signal) =>
        api.json(
          "searchFiles",
          {
            query: {
              sessionId,
              q: query,
              limit: 100,
              showHidden: showHidden ? "1" : undefined,
            },
          },
          signal,
        ),
      );
      if (!request.current()) return;
      this.host.patch({
        workspaceMatches: response.files,
        workspaceSearchTruncated: Boolean(response.truncated),
        workspaceSearchLoading: false,
        workspaceSearchError: null,
      });
    } catch (error) {
      if (!request.current()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      this.host.patch({
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
      workspaceDirectoryLoading: false,
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
