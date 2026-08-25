import type { ProjectDirEntry } from "../../shared/contracts";
import type { Api, ProjectFileResult } from "../api";

export interface WorkspaceBrowserState {
  /** Lazily loaded project-index levels, keyed by cwd-relative directory. */
  workspaceLevels: Record<string, ProjectDirEntry[]>;
  workspaceExpandedDirs: string[];
  workspaceLoadingDirs: string[];
  workspaceDirectoryErrors: Record<string, string>;
  /** One shared query and result projection for every workspace-file surface. */
  workspaceQuery: string;
  workspaceMatches: ProjectFileResult[];
  workspaceSearchLoading: boolean;
  workspaceSearchError: string | null;
  /** Lightweight workspace identity retained independently of preview bytes. */
  workspaceSelectedPath: string | null;
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
    workspaceSelectedPath: null,
  };
}

export interface WorkspaceControllerState extends WorkspaceBrowserState {
  sessionId: string | null;
  cwd: string | null;
}

export type WorkspaceBrowserPatch = Partial<WorkspaceBrowserState>;

interface WorkspaceControllerHost {
  state(): WorkspaceControllerState;
  patch(patch: WorkspaceBrowserPatch): void;
  api(): Api | null;
  transportGeneration(): number;
}

function normalizedDirectory(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Owns the shared workspace tree/search request lifecycle. AppStore remains
 * the sole snapshot publisher; the left quick explorer and right Files
 * workbench are two projections of this same state, never independent caches.
 */
export class WorkspaceController {
  private readonly directoryRequests = new Map<string, AbortController>();
  private searchRequest: AbortController | null = null;
  private requestGeneration = 0;

  constructor(private readonly host: WorkspaceControllerHost) {}

  invalidateForTransportReplacement(): void {
    this.cancelRequests();
    this.host.patch(emptyWorkspaceBrowserState());
  }

  cancelRequests(): void {
    this.requestGeneration += 1;
    for (const request of this.directoryRequests.values()) request.abort();
    this.directoryRequests.clear();
    this.searchRequest?.abort();
    this.searchRequest = null;
  }

  private owns(
    api: Api,
    transportGeneration: number,
    sessionId: string,
    cwd: string,
  ): boolean {
    const current = this.host.state();
    return (
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration &&
      current.sessionId === sessionId &&
      current.cwd === cwd
    );
  }

  async loadDirectory(
    requestedDir: string,
    options: { force?: boolean; refreshIndex?: boolean } = {},
  ): Promise<void> {
    const dir = normalizedDirectory(requestedDir);
    const state = this.host.state();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const { sessionId, cwd } = state;
    if (!api || !sessionId || !cwd) return;
    if (
      !options.force &&
      Object.prototype.hasOwnProperty.call(state.workspaceLevels, dir)
    )
      return;
    if (this.directoryRequests.has(dir)) return;

    const request = new AbortController();
    this.directoryRequests.set(dir, request);
    this.host.patch({
      workspaceLoadingDirs: [...new Set([...state.workspaceLoadingDirs, dir])],
      workspaceDirectoryErrors: Object.fromEntries(
        Object.entries(state.workspaceDirectoryErrors).filter(
          ([path]) => path !== dir,
        ),
      ),
    });
    try {
      const response = await api.listFiles(sessionId, dir, {
        signal: request.signal,
        refresh: options.refreshIndex,
      });
      if (
        request.signal.aborted ||
        this.directoryRequests.get(dir) !== request ||
        !this.owns(api, transportGeneration, sessionId, cwd)
      )
        return;
      this.host.patch({
        workspaceLevels: {
          ...this.host.state().workspaceLevels,
          [dir]: response.entries,
        },
      });
    } catch (error) {
      if (
        request.signal.aborted ||
        this.directoryRequests.get(dir) !== request ||
        !this.owns(api, transportGeneration, sessionId, cwd)
      )
        return;
      this.host.patch({
        workspaceDirectoryErrors: {
          ...this.host.state().workspaceDirectoryErrors,
          [dir]: errorMessage(error, "This directory could not be listed"),
        },
      });
    } finally {
      if (this.directoryRequests.get(dir) === request) {
        this.directoryRequests.delete(dir);
        if (this.owns(api, transportGeneration, sessionId, cwd)) {
          this.host.patch({
            workspaceLoadingDirs: this.host
              .state()
              .workspaceLoadingDirs.filter((path) => path !== dir),
          });
        }
      }
    }
  }

  toggleDirectory(requestedDir: string): void {
    const dir = normalizedDirectory(requestedDir);
    const current = this.host.state().workspaceExpandedDirs;
    const opening = !current.includes(dir);
    this.host.patch({
      workspaceExpandedDirs: opening
        ? [...current, dir]
        : current.filter((path) => path !== dir),
    });
    if (opening) void this.loadDirectory(dir);
  }

  /** Select and expand every ancestor needed to make a workspace file visible. */
  revealPath(workspacePath: string): void {
    const parts = workspacePath.split("/").filter(Boolean);
    const directories = parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join("/"));
    const current = this.host.state().workspaceExpandedDirs;
    this.host.patch({
      workspaceExpandedDirs: [...new Set([...current, ...directories])],
      workspaceSelectedPath: workspacePath,
    });
    void this.loadDirectory("");
    for (const directory of directories) void this.loadDirectory(directory);
  }

  setQuery(query: string): void {
    this.searchRequest?.abort();
    this.searchRequest = null;
    const normalized = query.trim();
    this.host.patch({
      workspaceQuery: query,
      workspaceSearchError: null,
      ...(normalized
        ? { workspaceSearchLoading: true }
        : { workspaceMatches: [], workspaceSearchLoading: false }),
    });
    if (!normalized) return;

    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const { sessionId, cwd } = this.host.state();
    if (!api || !sessionId || !cwd) {
      this.host.patch({ workspaceSearchLoading: false });
      return;
    }
    const request = new AbortController();
    this.searchRequest = request;
    void api
      .searchFiles(sessionId, normalized, 100, request.signal)
      .then(
        (response) => {
          if (
            request.signal.aborted ||
            this.searchRequest !== request ||
            !this.owns(api, transportGeneration, sessionId, cwd)
          )
            return;
          this.host.patch({
            workspaceMatches: response.files,
            workspaceSearchLoading: false,
            workspaceSearchError: null,
          });
        },
        (error: unknown) => {
          if (
            request.signal.aborted ||
            this.searchRequest !== request ||
            !this.owns(api, transportGeneration, sessionId, cwd)
          )
            return;
          this.host.patch({
            workspaceMatches: [],
            workspaceSearchLoading: false,
            workspaceSearchError: errorMessage(
              error,
              "Workspace search is unavailable",
            ),
          });
        },
      )
      .finally(() => {
        if (this.searchRequest === request) this.searchRequest = null;
      });
  }

  async refresh(): Promise<void> {
    const state = this.host.state();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    if (!api || !state.sessionId || !state.cwd) return;
    const { sessionId, cwd } = state;
    const expanded = [...state.workspaceExpandedDirs];
    const query = state.workspaceQuery;
    this.cancelRequests();
    const requestGeneration = this.requestGeneration;
    const current = () =>
      this.requestGeneration === requestGeneration &&
      this.owns(api, transportGeneration, sessionId, cwd);
    this.host.patch({
      workspaceLevels: {},
      workspaceLoadingDirs: [],
      workspaceDirectoryErrors: {},
      workspaceSearchError: null,
    });
    await this.loadDirectory("", { force: true, refreshIndex: true });
    if (!current()) return;
    await Promise.all(
      expanded.map((dir) => this.loadDirectory(dir, { force: true })),
    );
    if (!current()) return;
    if (query.trim()) this.setQuery(query);
  }
}
