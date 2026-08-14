import type {
  BranchForkResponse,
  BranchNavigateResponse,
  BranchTreeResponse,
  ProjectionConflict,
  ProjectionHealth,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";

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

export interface BranchControllerHost {
  state(): BranchControllerState;
  patch(patch: BranchControllerPatch): void;
  api(): Api | null;
  selectionGeneration(): number;
  selectionRequest(): number;
  beginForkSelection(): number;
  transportGeneration(): number;
  handleAuthFailure(): void;
  applyNavigation(response: BranchNavigateResponse): void;
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
        ? "Branch history is stale — reload after the session selection settles"
        : null,
    });
  }

  invalidateForViewChange(): void {
    this.invalidateRequests();
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
        ? "Branch history is stale — refresh after reconnecting"
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
          "Branch history is stale — refresh to use branch actions",
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
    this.host.patch({ branchTreeLoading: true, branchTreeError: null });
    try {
      const tree = await api.branchTree(sessionId);
      if (!this.ownsTreeRequest(request, ticket, api, transportGeneration))
        return;
      if (
        tree.sessionId !== ticket.sessionId ||
        tree.effectiveLeafId !== ticket.effectiveLeafId
      ) {
        this.host.patch({
          branchTreeError:
            "Branch history belongs to a different view — refresh the session before using branch actions",
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
      if (!this.ownsTreeRequest(request, ticket, api, transportGeneration))
        return;
      this.host.patch({
        branchTreeError:
          error instanceof Error
            ? error.message
            : "Failed to load branch history",
      });
    } finally {
      if (this.ownsTreeRequest(request, ticket, api, transportGeneration))
        this.host.patch({ branchTreeLoading: false });
    }
  }

  async navigate(targetId: string, mode: "switch" | "edit"): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const tree = state.branchTree;
    if (!api || !sessionId || !tree || this.actionsBlocked(state)) return false;
    const actionId = `${mode}:${targetId}`;
    const actionRequest = ++this.actionRequest;
    const ticket = this.viewTicket(state);
    const transportGeneration = this.host.transportGeneration();
    const owns = (): boolean =>
      actionRequest === this.actionRequest &&
      this.ownsView(ticket) &&
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    this.host.patch({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await api.navigateBranch({
        sessionId,
        revision: tree.revision,
        targetId,
        mode,
      });
      if (!owns()) return false;
      this.host.applyNavigation(response);
      await this.loadTree();
      return true;
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
      this.host.patch({
        branchTreeError:
          error instanceof Error ? error.message : "Branch navigation failed",
      });
      return false;
    } finally {
      if (owns() && this.host.state().branchActionId === actionId)
        this.host.patch({ branchActionId: null });
    }
  }

  /** Refreshes the tree before checking the target capability, so a transcript
   * row never supplies a revision or permission by itself. */
  async forkFromEntry(targetId: string): Promise<boolean> {
    const sessionId = this.host.state().sessionId;
    if (!sessionId || !targetId) return false;
    await this.loadTree();
    const state = this.host.state();
    if (state.sessionId !== sessionId) return false;
    const node = state.branchTree?.nodes.find(
      (candidate) => candidate.id === targetId,
    );
    if (!node?.canFork) {
      this.host.notify(
        "warning",
        state.branchTreeError ?? "That input is no longer available to fork",
      );
      return false;
    }
    const forked = await this.fork(targetId);
    if (!forked && this.host.state().sessionId === sessionId) {
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
    const tree = state.branchTree;
    if (!api || !sessionId || !tree || this.actionsBlocked(state)) return false;
    const actionId = `fork:${targetId}`;
    const selectionRequest = this.host.beginForkSelection();
    const actionRequest = ++this.actionRequest;
    const ticket: BranchViewTicket = {
      ...this.viewTicket(state),
      selectionRequest,
    };
    const transportGeneration = this.host.transportGeneration();
    const owns = (): boolean =>
      actionRequest === this.actionRequest &&
      this.ownsView(ticket) &&
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    this.host.patch({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await api.forkBranch({
        sessionId,
        revision: tree.revision,
        targetId,
      });
      if (!owns()) return false;
      this.host.applyFork(response);
      this.host.refreshSessionCatalog();
      return true;
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
      this.host.patch({
        branchTreeError: error instanceof Error ? error.message : "Fork failed",
      });
      return false;
    } finally {
      if (owns() && this.host.state().branchActionId === actionId)
        this.host.patch({ branchActionId: null });
    }
  }

  async returnToLatest(): Promise<boolean> {
    const state = this.host.state();
    const sessionId = state.sessionId;
    const durableLeafId = state.transcriptDurableLeafId;
    const effectiveLeafId = state.transcriptEffectiveLeafId;
    if (
      !sessionId ||
      !durableLeafId ||
      !effectiveLeafId ||
      durableLeafId === effectiveLeafId
    ) {
      return false;
    }
    await this.loadTree();
    const current = this.host.state();
    if (
      current.sessionId !== sessionId ||
      current.transcriptDurableLeafId !== durableLeafId ||
      current.transcriptEffectiveLeafId !== effectiveLeafId
    ) {
      return false;
    }
    const tree = current.branchTree;
    if (
      !tree ||
      tree.durableLeafId !== durableLeafId ||
      tree.effectiveLeafId !== effectiveLeafId
    ) {
      this.host.patch({
        branchTreeError:
          "Branch history changed — refresh the session before returning to latest",
      });
      return false;
    }
    return this.navigate(durableLeafId, "switch");
  }

  async forkCurrent(): Promise<boolean> {
    const state = this.host.state();
    const sessionId = state.sessionId;
    const durableLeafId = state.transcriptDurableLeafId;
    const effectiveLeafId = state.transcriptEffectiveLeafId;
    if (
      !sessionId ||
      !durableLeafId ||
      !effectiveLeafId ||
      durableLeafId === effectiveLeafId
    ) {
      return false;
    }
    await this.loadTree();
    const current = this.host.state();
    if (
      current.sessionId !== sessionId ||
      current.transcriptDurableLeafId !== durableLeafId ||
      current.transcriptEffectiveLeafId !== effectiveLeafId
    ) {
      return false;
    }
    const tree = current.branchTree;
    if (
      !tree ||
      tree.durableLeafId !== durableLeafId ||
      tree.effectiveLeafId !== effectiveLeafId
    ) {
      this.host.patch({
        branchTreeError:
          "Branch history changed — refresh the session before forking",
      });
      return false;
    }
    return this.fork(effectiveLeafId);
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

  private ownsView(ticket: BranchViewTicket): boolean {
    const state = this.host.state();
    return (
      state.sessionId === ticket.sessionId &&
      this.host.selectionGeneration() === ticket.selectionGeneration &&
      state.transcriptViewId === ticket.viewId &&
      state.transcriptEffectiveLeafId === ticket.effectiveLeafId &&
      this.host.selectionRequest() === ticket.selectionRequest
    );
  }

  private ownsTreeRequest(
    request: number,
    ticket: BranchViewTicket,
    api: Api,
    transportGeneration: number,
  ): boolean {
    return (
      request === this.treeRequest &&
      this.ownsView(ticket) &&
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration
    );
  }

  private actionsBlocked(state: BranchControllerState): boolean {
    return Boolean(
      state.branchActionId ||
        state.branchTreeLoading ||
        state.branchTreeError ||
        state.branchTree?.health.status === "error" ||
        state.projectionHealth.status === "error" ||
        state.projectionConflict,
    );
  }
}
