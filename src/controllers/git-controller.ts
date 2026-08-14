import type {
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
} from "../../shared/contracts";
import type { Api } from "../api";

const GIT_REFRESH_INTERVAL_MS = 4_000;

export type GitDiffView =
  | { status: "loading"; pathId: string; side: GitDiffSide }
  | { status: "error"; pathId: string; side: GitDiffSide; message: string }
  | { status: "ready"; result: GitDiffResponse };

export interface GitControllerState {
  sessionId: string | null;
  selectionGeneration: number;
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches";
  detailMode: "file" | "diff";
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
  detailMode?: "file" | "diff";
  gitStatus?: GitStatusResponse | null;
  gitStatusError?: string | null;
  gitStatusLoading?: boolean;
  gitStatusRefreshing?: boolean;
  selectedGitPathId?: string | null;
  selectedGitSide?: GitDiffSide | null;
  gitDiff?: GitDiffView | null;
}

export interface GitControllerHost {
  state(): GitControllerState;
  patch(patch: GitControllerPatch): void;
  api(): Api | null;
  transportGeneration(): number;
  cancelResourcePreview(): void;
  openResourceFromGit(workspacePath: string): Promise<void>;
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

  constructor(private readonly host: GitControllerHost) {}

  hasVisibleSurface(): boolean {
    return this.surfaces.size > 0;
  }

  setSurfaceVisible(surface: string, visible: boolean): void {
    const wasVisible = this.hasVisibleSurface();
    if (visible) this.surfaces.add(surface);
    else this.surfaces.delete(surface);
    if (this.hasVisibleSurface()) {
      if (!wasVisible) void this.refreshStatus();
      return;
    }
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
    if (!this.host.api() || !this.host.state().sessionId)
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

  /** Replaces a diff only through the Git side of the facade. Resource opening
   * is cancelled first, so a late file preview cannot overwrite the diff. */
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
    const side =
      requestedSide ??
      (change.unstaged || change.untracked || change.conflict
        ? "unstaged"
        : "staged");
    this.cancelDiff();
    this.host.cancelResourcePreview();
    const request = new AbortController();
    this.diffRequest = request;
    const selectionGeneration = state.selectionGeneration;
    const transportGeneration = this.host.transportGeneration();
    this.host.patch({
      resourcesOpen: true,
      contextMode: "changes",
      detailMode: "diff",
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

  /** A resource selection hides any active diff, but ResourceController never
   * learns the Git state shape or clears it itself. */
  prepareResourceOpen(contextMode: "files" | "changes"): void {
    this.cancelDiff();
    if (contextMode === "files") this.clearDiffSelection();
  }

  clearDiffSelection(): void {
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
  }

  async openFile(pathId: string): Promise<void> {
    const status = this.host.state().gitStatus;
    if (!status || status.kind !== "repository") return;
    const change = status.files.find(
      (candidate) => candidate.path.id === pathId,
    );
    const workingTreeDeleted =
      change?.unstaged?.kind === "deleted" ||
      (change?.staged?.kind === "deleted" &&
        !change.unstaged &&
        !change.untracked);
    if (
      !change?.path.workspacePath ||
      !change.path.utf8Path ||
      workingTreeDeleted
    )
      return;
    await this.host.openResourceFromGit(change.path.workspacePath);
  }

  cancelAll(): void {
    this.refreshQueued = false;
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
        const selectedExists =
          status.kind === "repository" &&
          status.files.some(
            (file) =>
              file.path.id === currentState.selectedGitPathId &&
              (file.conflict ||
                (currentState.selectedGitSide === "staged"
                  ? file.staged
                  : file.unstaged || file.untracked)),
          );
        const selectedPathId = currentState.selectedGitPathId;
        const selectedSide = currentState.selectedGitSide;
        const refreshSelectedDiff = Boolean(
          selectedExists &&
            selectedPathId &&
            selectedSide &&
            currentState.resourcesOpen &&
            currentState.contextMode === "changes" &&
            currentState.detailMode === "diff",
        );
        this.host.patch({
          gitStatus: status,
          gitStatusError: null,
          ...(!selectedExists && selectedPathId
            ? { selectedGitPathId: null, selectedGitSide: null, gitDiff: null }
            : {}),
        });
        if (refreshSelectedDiff)
          void this.openDiff(selectedPathId!, selectedSide!);
      } catch (error) {
        if (!current()) continue;
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
    } while (this.refreshQueued && this.hasVisibleSurface());
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
    if (!this.hasVisibleSurface() || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshStatus();
    }, GIT_REFRESH_INTERVAL_MS);
  }
}
