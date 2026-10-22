import type {
  BranchEntryResponse,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeQuery,
  BranchTreeResponse,
  ProjectionConflict,
  ProjectionHealth,
  SessionReadOnlyReason,
} from "../../shared/contracts";
import { type Api, ApiError } from "../api";
import type { CopyContent } from "../content-copy";

export interface BranchControllerState {
  sessionId: string | null;
  transcriptViewId: string | null;
  transcriptDurableLeafId: string | null;
  transcriptEffectiveLeafId: string | null;
  branchTree: BranchTreeResponse | null;
  branchTreeLoading: boolean;
  branchTreeError: string | null;
  branchActionId: string | null;
  projectionHealth: ProjectionHealth;
  projectionConflict: ProjectionConflict | null;
  readOnlyReason?: SessionReadOnlyReason | null;
}

/** Independent copies need a readable source, not control of its writer. */
function branchCopyBlockReason(state: BranchControllerState): string | null {
  if (state.readOnlyReason === "workspace-unavailable")
    return "The project folder is unavailable";
  if (state.branchActionId) return "A history action is in progress";
  if (state.projectionHealth.status === "error" || state.projectionConflict)
    return "Recover this session before continuing";
  return null;
}

export function branchCopiesBlocked(state: BranchControllerState): boolean {
  return branchCopyBlockReason(state) !== null;
}

export function branchActionsBlocked(state: BranchControllerState): boolean {
  return Boolean(
    state.readOnlyReason ||
      branchCopiesBlocked(state) ||
      state.branchTreeLoading ||
      state.branchTreeError ||
      state.branchTree?.health.status === "error",
  );
}

export interface BranchControllerPatch {
  branchTree?: BranchTreeResponse | null;
  branchTreeLoading?: boolean;
  branchTreeError?: string | null;
  branchActionId?: string | null;
}

interface BranchViewTicket {
  sessionId: string;
  selectionGeneration: number;
  viewId: string | null;
  effectiveLeafId: string | null;
  selectionRequest: number;
}

interface EarlierBranchSelection {
  durableLeafId: string;
  effectiveLeafId: string | null;
}

interface BranchControllerHost {
  state(): BranchControllerState;
  patch(patch: BranchControllerPatch): void;
  api(): Api | null;
  selectionGeneration(): number;
  selectionRequest(): number;
  beginForkSelection(): number;
  transportGeneration(): number;
  handleAuthFailure(): void;
  draftRevision(): number;
  applyNavigation(
    response: BranchNavigateResponse,
    draftRevision: number,
  ): void;
  applyFork(response: BranchForkResponse): void;
  refreshSessionCatalog(): void;
  notify(kind: "warning", text: string): void;
}

/**
 * Owns branch-tree loading and branch-command request lifecycles. Its host
 * remains the sole snapshot and selection authority: a controller can ask it
 * to apply an already-verified navigation/fork response, but never publishes
 * a parallel session state.
 */
export class BranchController {
  private treeRequest = 0;
  private actionRequest = 0;

  constructor(private readonly host: BranchControllerHost) {}

  invalidateForSelectionIntent(): void {
    this.invalidateRequests();
    const state = this.host.state();
    this.host.patch({
      branchTreeLoading: false,
      branchActionId: null,
      branchTreeError: state.branchTree
        ? "Refresh History after switching sessions"
        : null,
    });
  }

  invalidateForViewChange(): void {
    this.invalidateRequests();
    this.host.patch({ branchTreeLoading: false, branchActionId: null });
  }

  /** A new bootstrap owns a different API client, so an old tree/action can
   * neither commit nor leave the branch controls appearing actionable. */
  invalidateForTransportReplacement(): void {
    this.invalidateRequests();
    const state = this.host.state();
    this.host.patch({
      branchTreeLoading: false,
      branchActionId: null,
      branchTreeError: state.branchTree
        ? "Refresh History after reconnecting"
        : null,
    });
  }

  markConnectionInterrupted(): void {
    this.invalidateForTransportReplacement();
  }

  markProjectionStale(): void {
    if (this.host.state().branchTree) {
      this.host.patch({
        branchTreeError:
          "The conversation changed — refresh History before continuing",
      });
    }
  }

  async loadTree(): Promise<void> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    if (!api || !sessionId || state.branchTreeLoading) return;
    const request = ++this.treeRequest;
    const ticket = this.viewTicket(state);
    const transportGeneration = this.host.transportGeneration();
    const ownsRequest = (): boolean =>
      request === this.treeRequest &&
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    const owns = (): boolean => ownsRequest() && this.ownsView(ticket);
    this.host.patch({ branchTreeLoading: true, branchTreeError: null });
    try {
      const tree = await api.branchTree(sessionId);
      if (!owns()) return;
      if (
        tree.sessionId !== ticket.sessionId ||
        tree.effectiveLeafId !== ticket.effectiveLeafId
      ) {
        this.host.patch({
          branchTreeError:
            "The conversation changed — refresh History before continuing",
        });
        return;
      }
      this.host.patch({ branchTree: tree, branchTreeError: null });
    } catch (error) {
      // A current transport rejection is authoritative even when the user
      // navigated while the request was pending. A replaced transport is not.
      if (error instanceof ApiError && error.status === 401) {
        if (
          transportGeneration === this.host.transportGeneration() &&
          this.host.api() === api
        ) {
          this.host.handleAuthFailure();
        }
        return;
      }
      if (!owns()) return;
      this.host.patch({
        branchTreeError:
          error instanceof Error
            ? error.message
            : "History could not be loaded",
      });
    } finally {
      // An ordinary append can advance the leaf without invalidating the
      // request's view. Retire its loading marker even when its data is stale.
      if (ownsRequest())
        this.host.patch({
          branchTreeLoading: false,
          ...(!this.ownsView(ticket)
            ? {
                branchTreeError:
                  "Branch history changed — refresh to use branch actions",
              }
            : {}),
        });
    }
  }

  /** Outlines bind the current position; immutable entry/image reads bind only
   * the selected view. The pane cancels replaced searches and previews. */
  async readTree(
    query: BranchTreeQuery,
    signal?: AbortSignal,
  ): Promise<BranchTreeResponse | null> {
    return this.read((api, sessionId) =>
      api.branchTree(sessionId, query, signal),
    );
  }

  async readEntry(
    targetId: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<BranchEntryResponse | null> {
    const viewId = this.host.state().transcriptViewId;
    if (!viewId) return null;
    return this.read(
      (api, sessionId) =>
        api.branchEntry({ sessionId, viewId, targetId, offset }, signal),
      "view",
    );
  }

  async readImage(
    targetId: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    const viewId = this.host.state().transcriptViewId;
    if (!viewId) return null;
    return this.read(
      (api, sessionId) =>
        api.branchImage({ sessionId, viewId, targetId }, index, signal),
      "view",
    );
  }

  async copyContent(
    targetId: string,
    signal: AbortSignal,
  ): Promise<CopyContent | null> {
    const viewId = this.host.state().transcriptViewId;
    if (!viewId) return null;
    return this.read(async (api, sessionId) => {
      let offset = 0;
      const chunks: string[] = [];
      let imageEntries: NonNullable<BranchEntryResponse["images"]> = [];
      do {
        signal.throwIfAborted();
        const page = await api.branchEntry(
          { sessionId, viewId, targetId, offset },
          signal,
        );
        chunks.push(page.text);
        imageEntries = page.images ?? imageEntries;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
      const images: Blob[] = [];
      for (const image of imageEntries) {
        signal.throwIfAborted();
        images.push(
          await api.branchImage(
            { sessionId, viewId, targetId },
            image.index,
            signal,
          ),
        );
      }
      return { text: chunks.join(""), images };
    }, "view");
  }

  private async read<T>(
    perform: (api: Api, sessionId: string) => Promise<T>,
    ownership: "position" | "view" = "position",
  ): Promise<T | null> {
    const api = this.host.api();
    const state = this.host.state();
    if (!api || !state.sessionId) return null;
    const ticket = this.viewTicket(state);
    const generation = this.host.transportGeneration();
    try {
      const result = await perform(api, state.sessionId);
      return this.host.api() === api &&
        this.host.transportGeneration() === generation &&
        this.ownsView(ticket, ownership)
        ? result
        : null;
    } catch (error) {
      if (
        this.host.api() !== api ||
        this.host.transportGeneration() !== generation
      )
        return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return null;
      }
      if (!this.ownsView(ticket, ownership)) return null;
      throw error;
    }
  }

  async navigate(
    targetId: string,
    mode: "switch" | "edit",
    options: Pick<
      BranchNavigateRequest,
      "summarize" | "customInstructions"
    > = {},
  ): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const tree = state.branchTree;
    if (!api || !sessionId || !tree || branchActionsBlocked(state))
      return false;
    const draftRevision = this.host.draftRevision();
    return this.runAction(
      `${mode}:${targetId}`,
      api,
      this.viewTicket(state),
      () =>
        api.navigateBranch({
          sessionId,
          revision: tree.revision,
          targetId,
          mode,
          ...options,
        }),
      async (response) => {
        if (response.cancelled) {
          this.host.notify("warning", "Conversation change cancelled");
          return false;
        }
        this.host.applyNavigation(response, draftRevision);
        await this.loadTree();
      },
      "Branch navigation failed",
    );
  }

  /** Preparation belongs to the original gesture, not a later visit to the
   * same session. Reuse the read boundary for selection/view/transport fencing. */
  private async refreshForNavigation(): Promise<boolean> {
    return (
      (await this.read(async () => {
        await this.loadTree();
        return true;
      }, "position")) === true
    );
  }

  /** The server validates this retained target in the captured source view;
   * no preparatory tree refresh is needed. */
  async forkFromEntry(targetId: string): Promise<boolean> {
    const sessionId = this.host.state().sessionId;
    if (!sessionId || !targetId) return false;
    const pending = this.fork(targetId);
    const ticket = this.viewTicket(this.host.state());
    const transport = this.host.transportGeneration();
    const forked = await pending;
    if (
      !forked &&
      this.host.transportGeneration() === transport &&
      this.ownsView(ticket, "view")
    ) {
      this.host.notify(
        "warning",
        this.host.state().branchTreeError ?? "Fork failed",
      );
    }
    return forked;
  }

  async fork(targetId: string): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const viewId = state.transcriptViewId;
    if (!api || !sessionId || !viewId || branchCopiesBlocked(state))
      return false;
    const selectionRequest = this.host.beginForkSelection();
    return this.runAction(
      `fork:${targetId}`,
      api,
      { ...this.viewTicket(state), selectionRequest },
      () =>
        api.forkBranch({
          sessionId,
          viewId,
          targetId,
        }),
      (response) => {
        this.host.applyFork(response);
        this.host.refreshSessionCatalog();
      },
      "Fork failed",
      "view",
      async (response) => {
        await Promise.allSettled(
          (response.editorAttachments ?? []).map((item) =>
            api.deleteAttachment(item.id),
          ),
        );
      },
    );
  }

  async clone(targetId?: string, onFailure?: (message: string) => void): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const viewId = state.transcriptViewId;
    if (!api || !sessionId || !viewId) return false;
    const blocked = branchCopyBlockReason(state);
    if (blocked) {
      onFailure?.(blocked);
      return false;
    }
    const endpoint = targetId ?? state.transcriptEffectiveLeafId;
    const selectionRequest = this.host.beginForkSelection();
    return this.runAction(
      `clone:${targetId ?? "current"}`,
      api,
      { ...this.viewTicket(state), selectionRequest },
      () =>
        api.cloneBranch({
          sessionId,
          viewId,
          targetId: endpoint,
        }),
      (response) => {
        this.host.applyFork(response);
        this.host.refreshSessionCatalog();
      },
      "Clone failed",
      "view",
      undefined,
      onFailure,
    );
  }

  private async runAction<T>(
    actionId: string,
    api: Api,
    ticket: BranchViewTicket,
    perform: () => Promise<T>,
    commit: (response: T) => boolean | void | Promise<boolean | void>,
    fallbackError: string,
    ownership: "position" | "view" = "position",
    discard?: (response: T) => Promise<void>,
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    const actionRequest = ++this.actionRequest;
    const transportGeneration = this.host.transportGeneration();
    const ownsRequest = (): boolean =>
      actionRequest === this.actionRequest &&
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    // Independent copies capture their prefix at admission. Source progress may
    // continue while publishing; only a replaced view/selection invalidates opening it.
    const owns = (): boolean =>
      ownsRequest() && this.ownsView(ticket, ownership);
    this.host.patch({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await perform();
      if (!owns()) {
        await discard?.(response);
        return false;
      }
      return (await commit(response)) !== false;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (
          transportGeneration === this.host.transportGeneration() &&
          this.host.api() === api
        ) {
          this.host.handleAuthFailure();
        }
        return false;
      }
      if (!owns()) return false;
      const message = error instanceof Error ? error.message : fallbackError;
      this.host.patch({ branchTreeError: message });
      onFailure?.(message);
      return false;
    } finally {
      if (ownsRequest() && this.host.state().branchActionId === actionId)
        this.host.patch({
          branchActionId: null,
          ...(!this.ownsView(ticket, ownership)
            ? {
                branchTreeError:
                  "Branch history changed — refresh to use branch actions",
              }
            : {}),
        });
    }
  }

  private async resolveCurrentEarlierBranch(
    changedMessage: string,
  ): Promise<EarlierBranchSelection | null> {
    const state = this.host.state();
    const sessionId = state.sessionId;
    const durableLeafId = state.transcriptDurableLeafId;
    const effectiveLeafId = state.transcriptEffectiveLeafId;
    if (!sessionId || !durableLeafId || durableLeafId === effectiveLeafId) {
      return null;
    }
    if (!(await this.refreshForNavigation())) return null;
    const current = this.host.state();
    if (current.transcriptDurableLeafId !== durableLeafId) {
      return null;
    }
    const tree = current.branchTree;
    if (
      !tree ||
      tree.durableLeafId !== durableLeafId ||
      tree.effectiveLeafId !== effectiveLeafId
    ) {
      this.host.patch({ branchTreeError: changedMessage });
      return null;
    }
    return { durableLeafId, effectiveLeafId };
  }

  async returnToLatest(): Promise<boolean> {
    const branch = await this.resolveCurrentEarlierBranch(
      "Branch history changed — refresh the session before returning to latest",
    );
    return branch ? this.navigate(branch.durableLeafId, "switch") : false;
  }

  private invalidateRequests(): void {
    this.treeRequest += 1;
    this.actionRequest += 1;
  }

  private viewTicket(state: BranchControllerState): BranchViewTicket {
    const sessionId = state.sessionId;
    if (!sessionId) throw new Error("A branch request requires a session");
    return {
      sessionId,
      selectionGeneration: this.host.selectionGeneration(),
      viewId: state.transcriptViewId,
      effectiveLeafId: state.transcriptEffectiveLeafId,
      selectionRequest: this.host.selectionRequest(),
    };
  }

  private ownsView(
    ticket: BranchViewTicket,
    ownership: "position" | "view" = "position",
  ): boolean {
    const state = this.host.state();
    return (
      state.sessionId === ticket.sessionId &&
      this.host.selectionGeneration() === ticket.selectionGeneration &&
      state.transcriptViewId === ticket.viewId &&
      (ownership === "view" ||
        state.transcriptEffectiveLeafId === ticket.effectiveLeafId) &&
      this.host.selectionRequest() === ticket.selectionRequest
    );
  }
}
