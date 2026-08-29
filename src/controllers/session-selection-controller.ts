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
    await this.runSelection(
      id,
      api,
      () => api.openSession(id),
      "Failed to open session",
      undefined,
      (_snapshot, ticket) => {
        this.host.ensureSessionVisible(id);
        if (this.host.consumeReadyWhileOpening(id, ticket)) {
          this.host.resyncSelected(id);
        }
      },
    );
  }

  async deselect(): Promise<boolean> {
    const api = this.host.api();
    if (!api) return false;
    return this.runSelection(
      null,
      api,
      () => api.deselectSession(),
      "Failed to open New session",
      false,
      (snapshot) => snapshot.active === null,
    );
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
    return this.runSelection(
      null,
      api,
      () => api.newSession(target, options),
      "Failed to create session",
      null,
      (snapshot) => {
        const sessionId = snapshot.active?.sessionId ?? null;
        if (sessionId) this.host.ensureSessionVisible(sessionId);
        if (options.model) this.host.rememberModel(options.model);
        this.host.refreshSessionCatalog();
        return sessionId;
      },
    );
  }

  private async runSelection<T>(
    openingSessionId: string | null,
    api: Api,
    request: () => Promise<ActiveSnapshot>,
    fallbackMessage: string,
    staleResult: T,
    afterApply: (snapshot: ActiveSnapshot, ticket: number) => T,
  ): Promise<T> {
    const transportGeneration = this.host.transportGeneration();
    const ticket = this.host.beginOpening(openingSessionId);
    try {
      const snapshot = await request();
      if (!this.host.ownsOpening(ticket, api, transportGeneration))
        return staleResult;
      this.host.applySnapshot(snapshot);
      this.host.setActionError(null);
      return afterApply(snapshot, ticket);
    } catch (error) {
      if (this.host.ownsOpening(ticket, api, transportGeneration)) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else
          this.host.setActionError(
            error instanceof Error ? error.message : fallbackMessage,
          );
      }
      return staleResult;
    } finally {
      this.host.releaseOpening(ticket);
    }
  }
}
