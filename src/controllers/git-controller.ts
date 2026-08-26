import type {
  GitDiffResponse,
  GitDiffSide,
  GitFileChange,
  GitStatusResponse,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";

const GIT_DETAIL_REFRESH_INTERVAL_MS = 4_000;
const GIT_TOPBAR_REFRESH_INTERVAL_MS = 20_000;
const TOPBAR_SURFACE = "topbar-git";

function changeHasSide(change: GitFileChange, side: GitDiffSide): boolean {
  return side === "staged"
    ? Boolean(change.staged)
    : Boolean(change.unstaged || change.untracked || change.conflict);
}

export type GitDiffView =
  | { status: "loading"; pathId: string; side: GitDiffSide }
  | { status: "error"; pathId: string; side: GitDiffSide; message: string }
  | { status: "ready"; result: GitDiffResponse };

export interface GitControllerState {
  sessionId: string | null;
  selectionGeneration: number;
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches";
  gitStatus: GitStatusResponse | null;
  gitStatusError: string | null;
  gitStatusLoading: boolean;
  gitStatusRefreshing: boolean;
  selectedGitPathId: string | null;
  selectedGitSide: GitDiffSide | null;
  gitDiff: GitDiffView | null;
}

export interface GitControllerPatch {
  resourcesOpen?: boolean;
  contextMode?: "files" | "changes" | "branches";
  gitStatus?: GitStatusResponse | null;
  gitStatusError?: string | null;
  gitStatusLoading?: boolean;
  gitStatusRefreshing?: boolean;
  selectedGitPathId?: string | null;
  selectedGitSide?: GitDiffSide | null;
  gitDiff?: GitDiffView | null;
}

interface GitControllerHost {
  state(): GitControllerState;
  patch(patch: GitControllerPatch): void;
  api(): Api | null;
  transportGeneration(): number;
  openResourceFromGit(workspacePath: string): Promise<void>;
  handleAuthFailure(): void;
}

/**
 * Owns Git request, cancellation, and polling lifecycles. AppStore remains the
 * single canonical state publisher: it supplies the visible snapshot and
 * cross-domain resource transition through this narrow host interface.
 */
export class GitController {
  private statusRequest: AbortController | null = null;
  private statusPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private diffRequest: AbortController | null = null;
  private surfaces = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private observingVisibility = false;
  private selectedWorkspacePath: string | null = null;

  constructor(private readonly host: GitControllerHost) {}

  hasVisibleSurface(): boolean {
    return this.surfaces.size > 0;
  }

  setSurfaceVisible(surface: string, visible: boolean): void {
    const previousInterval = this.refreshInterval();
    if (visible) this.surfaces.add(surface);
    else this.surfaces.delete(surface);
    const nextInterval = this.refreshInterval();
    if (nextInterval !== null) {
      this.observeVisibility();
      if (previousInterval === null) {
        void this.refreshStatus();
      } else if (previousInterval !== nextInterval) {
        this.clearRefreshTimer();
        if (nextInterval < previousInterval) void this.refreshStatus();
        else if (!this.statusPromise) this.scheduleRefresh();
      }
      return;
    }
    this.unobserveVisibility();
    this.clearRefreshTimer();
    this.refreshQueued = false;
    this.statusRequest?.abort();
    this.statusRequest = null;
    const state = this.host.state();
    if (state.gitStatusLoading || state.gitStatusRefreshing) {
      this.host.patch({ gitStatusLoading: false, gitStatusRefreshing: false });
    }
  }

  refreshStatus(): Promise<void> {
    if (!this.pageVisible() || !this.host.api() || !this.host.state().sessionId)
      return Promise.resolve();
    if (this.statusPromise) {
      this.refreshQueued = true;
      return this.statusPromise;
    }
    this.clearRefreshTimer();
    this.statusPromise = this.runStatusRefresh().finally(() => {
      this.statusPromise = null;
      this.scheduleRefresh();
    });
    return this.statusPromise;
  }

  async openDiff(pathId: string, requestedSide?: GitDiffSide): Promise<void> {
    let state = this.host.state();
    if (!this.host.api() || !state.sessionId) return;
    let status = state.gitStatus;
    if (!status) {
      await this.refreshStatus();
      state = this.host.state();
      status = state.gitStatus;
    }
    const api = this.host.api();
    const sessionId = state.sessionId;
    if (!api || !sessionId || !status || status.kind !== "repository") return;
    const change = status.files.find(
      (candidate) => candidate.path.id === pathId,
    );
    if (!change) return;
    this.selectedWorkspacePath = change.path.workspacePath ?? null;
    const side =
      requestedSide ??
      (change.unstaged || change.untracked || change.conflict
        ? "unstaged"
        : "staged");
    this.cancelDiff();
    const request = new AbortController();
    this.diffRequest = request;
    const selectionGeneration = state.selectionGeneration;
    const transportGeneration = this.host.transportGeneration();
    this.host.patch({
      resourcesOpen: true,
      contextMode: "changes",
      selectedGitPathId: pathId,
      selectedGitSide: side,
      gitDiff: { status: "loading", pathId, side },
    });
    const current = (): boolean => {
      const currentState = this.host.state();
      return (
        this.diffRequest === request &&
        !request.signal.aborted &&
        this.host.api() === api &&
        this.host.transportGeneration() === transportGeneration &&
        currentState.sessionId === sessionId &&
        currentState.selectionGeneration === selectionGeneration &&
        currentState.selectedGitPathId === pathId &&
        currentState.selectedGitSide === side
      );
    };
    try {
      const result = await api.gitDiff(sessionId, pathId, side, request.signal);
      if (!current()) return;
      this.host.patch({ gitDiff: { status: "ready", result } });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      this.host.patch({
        gitDiff: {
          status: "error",
          pathId,
          side,
          message: error instanceof Error ? error.message : "Diff failed",
        },
      });
    } finally {
      if (this.diffRequest === request) this.diffRequest = null;
    }
  }

  setDiffSide(side: GitDiffSide): void {
    const state = this.host.state();
    if (state.selectedGitPathId && side !== state.selectedGitSide)
      void this.openDiff(state.selectedGitPathId, side);
  }

  /** Keep Changes aligned with a resource selected from either Files surface. */
  selectWorkspacePath(workspacePath: string): void {
    this.selectedWorkspacePath = workspacePath;
    const status = this.host.state().gitStatus;
    if (!status || status.kind !== "repository") return;
    const change = status.files.find(
      (candidate) => candidate.path.workspacePath === workspacePath,
    );
    if (!change) {
      this.cancelDiff();
      const state = this.host.state();
      if (
        state.selectedGitPathId !== null ||
        state.selectedGitSide !== null ||
        state.gitDiff !== null
      ) {
        this.host.patch({
          selectedGitPathId: null,
          selectedGitSide: null,
          gitDiff: null,
        });
      }
      return;
    }
    const state = this.host.state();
    const side =
      state.selectedGitPathId === change.path.id &&
      state.selectedGitSide &&
      changeHasSide(change, state.selectedGitSide)
        ? state.selectedGitSide
        : change.unstaged || change.untracked || change.conflict
          ? "unstaged"
          : "staged";
    if (
      state.selectedGitPathId !== change.path.id ||
      state.selectedGitSide !== side
    ) {
      this.host.patch({
        selectedGitPathId: change.path.id,
        selectedGitSide: side,
        gitDiff: null,
      });
    }
  }

  /** Resource loading supersedes an in-flight diff transfer. Files selections
   * also release the Git identity; Changes selections retain it. */
  prepareResourceOpen(contextMode: "files" | "changes"): void {
    this.cancelDiff();
    if (contextMode === "files") this.clearDiffSelection();
  }

  clearDiffSelection(): void {
    this.cancelDiff();
    this.selectedWorkspacePath = null;
    const state = this.host.state();
    if (
      state.selectedGitPathId !== null ||
      state.selectedGitSide !== null ||
      state.gitDiff !== null
    ) {
      this.host.patch({
        selectedGitPathId: null,
        selectedGitSide: null,
        gitDiff: null,
      });
    }
  }

  async openChange(pathId: string, requestedSide?: GitDiffSide): Promise<void> {
    let status = this.host.state().gitStatus;
    if (!status) {
      await this.refreshStatus();
      status = this.host.state().gitStatus;
    }
    if (!status || status.kind !== "repository") return;
    const change = status.files.find(
      (candidate) => candidate.path.id === pathId,
    );
    if (!change) return;
    const side =
      requestedSide ??
      (change.unstaged || change.untracked || change.conflict
        ? "unstaged"
        : "staged");
    this.selectedWorkspacePath = change.path.workspacePath ?? null;
    const deleted =
      side === "staged"
        ? change.staged?.kind === "deleted"
        : change.unstaged?.kind === "deleted";
    if (change.path.workspacePath && change.path.utf8Path && !deleted)
      void this.host.openResourceFromGit(change.path.workspacePath);
    await this.openDiff(pathId, side);
  }

  cancelAll(): void {
    this.refreshQueued = false;
    this.selectedWorkspacePath = null;
    this.statusRequest?.abort();
    this.statusRequest = null;
    this.cancelDiff();
  }

  private async runStatusRefresh(): Promise<void> {
    do {
      this.refreshQueued = false;
      const api = this.host.api();
      const state = this.host.state();
      const sessionId = state.sessionId;
      if (!api || !sessionId) return;
      const request = new AbortController();
      this.statusRequest = request;
      const selectionGeneration = state.selectionGeneration;
      const transportGeneration = this.host.transportGeneration();
      this.host.patch({
        gitStatusLoading: state.gitStatus === null,
        gitStatusRefreshing: state.gitStatus !== null,
      });
      const current = (): boolean => {
        const currentState = this.host.state();
        return (
          this.statusRequest === request &&
          !request.signal.aborted &&
          this.host.api() === api &&
          this.host.transportGeneration() === transportGeneration &&
          currentState.sessionId === sessionId &&
          currentState.selectionGeneration === selectionGeneration
        );
      };
      try {
        const status = await api.gitStatus(sessionId, request.signal);
        if (!current()) continue;
        const currentState = this.host.state();
        const workspaceChange =
          status.kind === "repository" && this.selectedWorkspacePath
            ? status.files.find(
                (file) =>
                  file.path.workspacePath === this.selectedWorkspacePath,
              )
            : undefined;
        let selectedPathId = currentState.selectedGitPathId;
        let selectedSide = currentState.selectedGitSide;
        if (this.selectedWorkspacePath) {
          if (workspaceChange) {
            const retainedSide =
              currentState.selectedGitPathId === workspaceChange.path.id &&
              currentState.selectedGitSide &&
              changeHasSide(workspaceChange, currentState.selectedGitSide)
                ? currentState.selectedGitSide
                : null;
            selectedPathId = workspaceChange.path.id;
            selectedSide =
              retainedSide ??
              (workspaceChange.unstaged ||
              workspaceChange.untracked ||
              workspaceChange.conflict
                ? "unstaged"
                : "staged");
          } else {
            selectedPathId = null;
            selectedSide = null;
          }
        }
        const candidateSide = selectedSide;
        const selectedExists =
          status.kind === "repository" &&
          candidateSide !== null &&
          status.files.some(
            (file) =>
              file.path.id === selectedPathId &&
              changeHasSide(file, candidateSide),
          );
        if (!selectedExists) {
          selectedPathId = null;
          selectedSide = null;
        }
        const selectionChanged =
          selectedPathId !== currentState.selectedGitPathId ||
          selectedSide !== currentState.selectedGitSide;
        this.host.patch({
          gitStatus: status,
          gitStatusError: null,
          ...(selectionChanged
            ? {
                selectedGitPathId: selectedPathId,
                selectedGitSide: selectedSide,
                gitDiff: null,
              }
            : {}),
        });
      } catch (error) {
        if (!current()) continue;
        if (error instanceof ApiError && error.status === 401) {
          this.host.handleAuthFailure();
          return;
        }
        this.host.patch({
          gitStatusError:
            error instanceof Error
              ? error.message
              : "Git status refresh failed",
        });
      } finally {
        if (this.statusRequest === request) {
          this.statusRequest = null;
          this.host.patch({
            gitStatusLoading: false,
            gitStatusRefreshing: false,
          });
        }
      }
    } while (
      this.refreshQueued &&
      this.hasVisibleSurface() &&
      this.pageVisible()
    );
  }

  private cancelDiff(): void {
    this.diffRequest?.abort();
    this.diffRequest = null;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private scheduleRefresh(): void {
    const interval = this.refreshInterval();
    if (interval === null || !this.pageVisible() || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshStatus();
    }, interval);
  }

  private refreshInterval(): number | null {
    if (!this.hasVisibleSurface()) return null;
    return [...this.surfaces].some((surface) => surface !== TOPBAR_SURFACE)
      ? GIT_DETAIL_REFRESH_INTERVAL_MS
      : GIT_TOPBAR_REFRESH_INTERVAL_MS;
  }

  private pageVisible(): boolean {
    return (
      typeof document === "undefined" || document.visibilityState !== "hidden"
    );
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.pageVisible()) {
      this.clearRefreshTimer();
      this.refreshQueued = false;
      this.statusRequest?.abort();
      return;
    }
    if (this.hasVisibleSurface()) void this.refreshStatus();
  };

  private observeVisibility(): void {
    if (this.observingVisibility || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.observingVisibility = true;
  }

  private unobserveVisibility(): void {
    if (!this.observingVisibility || typeof document === "undefined") return;
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.observingVisibility = false;
  }
}
