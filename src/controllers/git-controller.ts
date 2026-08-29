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

interface GitChangeSelection {
  api: Api;
  sessionId: string;
  selectionGeneration: number;
  transportGeneration: number;
  change: GitFileChange;
  side: GitDiffSide;
}

/**
 * Owns Git request, cancellation, and polling lifecycles. AppStore remains the
 * single canonical state publisher: it supplies the visible snapshot and
 * cross-domain resource transition through this narrow host interface.
 */
export class GitController {
  private statusRequest: AbortController | null = null;
  private statusPromise: Promise<void> | null = null;
  private statusEpoch = 0;
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
    this.cancelStatusRefresh();
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
    const epoch = this.statusEpoch;
    const promise = this.runStatusRefresh(epoch).finally(() => {
      if (this.statusPromise !== promise) return;
      this.statusPromise = null;
      this.scheduleRefresh();
    });
    this.statusPromise = promise;
    return promise;
  }

  private async resolveChange(
    pathId: string,
    requestedSide?: GitDiffSide,
  ): Promise<GitChangeSelection | null> {
    let state = this.host.state();
    const api = this.host.api();
    const sessionId = state.sessionId;
    const selectionGeneration = state.selectionGeneration;
    const transportGeneration = this.host.transportGeneration();
    if (!api || !sessionId) return null;
    let status = state.gitStatus;
    if (!status) {
      await this.refreshStatus();
      state = this.host.state();
      status = state.gitStatus;
      if (
        this.host.api() !== api ||
        this.host.transportGeneration() !== transportGeneration ||
        state.sessionId !== sessionId ||
        state.selectionGeneration !== selectionGeneration
      )
        return null;
    }
    if (!status || status.kind !== "repository") return null;
    const change = status.files.find(
      (candidate) => candidate.path.id === pathId,
    );
    if (!change) return null;
    const side =
      requestedSide ??
      (change.unstaged || change.untracked || change.conflict
        ? "unstaged"
        : "staged");
    return changeHasSide(change, side)
      ? {
          api,
          sessionId,
          selectionGeneration,
          transportGeneration,
          change,
          side,
        }
      : null;
  }

  private async openResolvedDiff({
    api,
    sessionId,
    selectionGeneration,
    transportGeneration,
    change,
    side,
  }: GitChangeSelection): Promise<void> {
    const pathId = change.path.id;
    this.selectedWorkspacePath = change.path.workspacePath ?? null;
    this.cancelDiff();
    const request = new AbortController();
    this.diffRequest = request;
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
      if (result.path.id !== pathId || result.side !== side)
        throw new Error("The Host returned a diff for another selection");
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

  async openDiff(pathId: string, requestedSide?: GitDiffSide): Promise<void> {
    const selection = await this.resolveChange(pathId, requestedSide);
    if (selection) await this.openResolvedDiff(selection);
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
    const selection = await this.resolveChange(pathId, requestedSide);
    if (!selection) return;
    const { change, side } = selection;
    this.selectedWorkspacePath = change.path.workspacePath ?? null;
    const deleted =
      side === "staged"
        ? change.staged?.kind === "deleted"
        : change.unstaged?.kind === "deleted";
    if (change.path.workspacePath && change.path.utf8Path && !deleted)
      void this.host.openResourceFromGit(change.path.workspacePath);
    await this.openResolvedDiff(selection);
  }

  /** A replacement API cannot inherit request ownership from its predecessor.
   * Keep the last good status visible, but discard loading flags and diff bytes
   * whose freshness cannot be established across the transport boundary. */
  invalidateForTransportReplacement(): void {
    this.clearRefreshTimer();
    this.cancelStatusRefresh();
    this.cancelDiff();
    const state = this.host.state();
    this.host.patch({
      ...(state.gitStatusLoading ? { gitStatusLoading: false } : {}),
      ...(state.gitStatusRefreshing ? { gitStatusRefreshing: false } : {}),
      ...(state.gitDiff ? { gitDiff: null } : {}),
    });
  }

  /** Revalidate retained status after bootstrap and restore an open Changes
   * detail exactly once. Ordinary polling deliberately leaves a stable diff
   * alone so reader scroll is not reset. */
  async resumeAfterTransportReplacement(): Promise<void> {
    if (!this.hasVisibleSurface() || !this.pageVisible()) return;
    await this.refreshStatus();
    const state = this.host.state();
    if (
      state.resourcesOpen &&
      state.contextMode === "changes" &&
      state.gitStatusError === null &&
      state.gitDiff === null &&
      state.selectedGitPathId &&
      state.selectedGitSide
    ) {
      await this.openDiff(state.selectedGitPathId, state.selectedGitSide);
    }
  }

  cancelAll(): void {
    this.invalidateForTransportReplacement();
    this.selectedWorkspacePath = null;
  }

  private async runStatusRefresh(epoch: number): Promise<void> {
    do {
      if (epoch !== this.statusEpoch) return;
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
          epoch === this.statusEpoch &&
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
        if (
          selectionChanged &&
          selectedPathId &&
          selectedSide &&
          currentState.resourcesOpen &&
          currentState.contextMode === "changes"
        ) {
          void this.openDiff(selectedPathId, selectedSide);
        }
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
      epoch === this.statusEpoch &&
      this.refreshQueued &&
      this.hasVisibleSurface() &&
      this.pageVisible()
    );
  }

  private cancelStatusRefresh(): void {
    this.statusEpoch += 1;
    this.refreshQueued = false;
    this.statusRequest?.abort();
    this.statusRequest = null;
    this.statusPromise = null;
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
    return document.visibilityState !== "hidden";
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.pageVisible()) {
      this.clearRefreshTimer();
      this.cancelStatusRefresh();
      const state = this.host.state();
      if (state.gitStatusLoading || state.gitStatusRefreshing) {
        this.host.patch({
          gitStatusLoading: false,
          gitStatusRefreshing: false,
        });
      }
      return;
    }
    if (this.hasVisibleSurface()) void this.refreshStatus();
  };

  private observeVisibility(): void {
    if (this.observingVisibility) return;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.observingVisibility = true;
  }

  private unobserveVisibility(): void {
    if (!this.observingVisibility) return;
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.observingVisibility = false;
  }
}
