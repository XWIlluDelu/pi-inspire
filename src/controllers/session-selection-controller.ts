import type {
  ActiveSnapshot,
  ModelIdentity,
  NewSessionOptions,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";

export interface SessionSelectionState {
  sessionId: string | null;
  cwd: string | null;
  openingSessionId: string | null;
}

interface SessionSelectionControllerHost {
  state(): SessionSelectionState;
  api(): Api | null;
  transportGeneration(): number;
  /** Starts a new explicit selection intent and returns its unique owner. */
  beginOpening(sessionId: string | null): number;
  invalidateOpening(): void;
  ownsOpening(ticket: number, api: Api, transportGeneration: number): boolean;
  releaseOpening(ticket: number): void;
  applySnapshot(snapshot: ActiveSnapshot): void;
  ensureSessionVisible(sessionId: string): void;
  consumeReadyWhileOpening(sessionId: string, ticket: number): boolean;
  resyncSelected(sessionId: string): void;
  setActionError(message: string | null): void;
  rememberModel(model: ModelIdentity): void;
  refreshSessionCatalog(): void;
  notify(kind: "warning", text: string): void;
  handleAuthFailure(): void;
}

/**
 * Owns open/new/deselect request ownership. AppStore remains the only session
 * snapshot and cross-domain commit facade; this controller only accepts a
 * response while its explicit selection owner, API client, and transport
 * generation still match.
 */
export class SessionSelectionController {
  constructor(private readonly host: SessionSelectionControllerHost) {}

  /** A replacement bootstrap or authoritative stream snapshot supersedes every
   * in-flight selection, including one that may never answer on an old client. */
  invalidateForReplacement(): void {
    this.host.invalidateOpening();
  }

  async open(id: string): Promise<void> {
    const state = this.host.state();
    const api = this.host.api();
    if (!api) return;
    // Re-selecting the visible session is a no-op only with no older operation
    // to supersede. A newer intent must still invalidate a pending open.
    if (id === state.sessionId && state.openingSessionId === null) return;
    if (id === state.openingSessionId) return;
    const transportGeneration = this.host.transportGeneration();
    const ticket = this.host.beginOpening(id);
    try {
      const snapshot = await api.openSession(id);
      if (!this.owns(ticket, api, transportGeneration)) return;
      this.host.applySnapshot(snapshot);
      this.host.ensureSessionVisible(id);
      this.host.setActionError(null);
      if (this.host.consumeReadyWhileOpening(id, ticket)) {
        this.host.resyncSelected(id);
      }
    } catch (error) {
      if (this.owns(ticket, api, transportGeneration)) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else
          this.host.setActionError(
            error instanceof Error ? error.message : "Failed to open session",
          );
      }
    } finally {
      this.host.releaseOpening(ticket);
    }
  }

  async deselect(): Promise<boolean> {
    const api = this.host.api();
    if (!api) return false;
    const transportGeneration = this.host.transportGeneration();
    const ticket = this.host.beginOpening(null);
    try {
      const snapshot = await api.deselectSession();
      if (!this.owns(ticket, api, transportGeneration)) return false;
      this.host.applySnapshot(snapshot);
      this.host.setActionError(null);
      return snapshot.active === null;
    } catch (error) {
      if (this.owns(ticket, api, transportGeneration)) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else
          this.host.setActionError(
            error instanceof Error
              ? error.message
              : "Failed to open New session",
          );
      }
      return false;
    } finally {
      this.host.releaseOpening(ticket);
    }
  }

  /** Creates a session without inventing a fallback project root. */
  async create(
    cwd?: string,
    nameOrOptions: string | NewSessionOptions = {},
  ): Promise<string | null> {
    const api = this.host.api();
    if (!api) return null;
    const options =
      typeof nameOrOptions === "string"
        ? { name: nameOrOptions }
        : nameOrOptions;
    const target = cwd?.trim() || this.host.state().cwd;
    if (!target) {
      this.host.notify(
        "warning",
        "Enter a project directory to start a session",
      );
      return null;
    }
    const transportGeneration = this.host.transportGeneration();
    const ticket = this.host.beginOpening(null);
    try {
      const snapshot = await api.newSession(target, options);
      if (!this.owns(ticket, api, transportGeneration)) return null;
      this.host.applySnapshot(snapshot);
      const sessionId = snapshot.active?.sessionId ?? null;
      if (sessionId) this.host.ensureSessionVisible(sessionId);
      if (options.model) this.host.rememberModel(options.model);
      this.host.setActionError(null);
      this.host.refreshSessionCatalog();
      return sessionId;
    } catch (error) {
      if (this.owns(ticket, api, transportGeneration)) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else
          this.host.setActionError(
            error instanceof Error ? error.message : "Failed to create session",
          );
      }
      return null;
    } finally {
      this.host.releaseOpening(ticket);
    }
  }

  private owns(ticket: number, api: Api, transportGeneration: number): boolean {
    return this.host.ownsOpening(ticket, api, transportGeneration);
  }
}
