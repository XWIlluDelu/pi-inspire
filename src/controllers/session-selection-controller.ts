import type {
  ActiveSnapshot,
  ModelIdentity,
  NewSessionOptions,
} from "../../shared/contracts";
import { type Api, ApiError, ApiRequestCancelledError } from "../api";

export interface SessionSelectionState {
  sessionId: string | null;
  cwd: string | null;
  openingSessionId: string | null;
  sessionSelectionPending: boolean;
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
  confirmUncertainCreation(): boolean;
}

/**
 * Owns open/new/deselect request ownership. AppStore remains the only session
 * snapshot and cross-domain commit facade; this controller only accepts a
 * response while its explicit selection owner, API client, and transport
 * generation still match.
 */
export class SessionSelectionController {
  private observation: AbortController | null = null;
  private creation: "pending" | "uncertain" | null = null;

  constructor(private readonly host: SessionSelectionControllerHost) {}

  /** A replacement bootstrap or unaddressed selection push supersedes every
   * in-flight selection, including one that may never answer on an old client. */
  invalidateForReplacement(): void {
    this.host.invalidateOpening();
    this.observation?.abort();
    this.observation = null;
  }

  async open(id: string): Promise<void> {
    const state = this.host.state();
    const api = this.host.api();
    if (!api) return;
    // Re-selecting the visible session is a no-op only with no older operation
    // to supersede, including create/deselect intents with no target ID yet.
    if (id === state.sessionId && !state.sessionSelectionPending) return;
    if (id === state.openingSessionId) return;
    await this.runSelection(
      id,
      api,
      (signal) => api.openSession(id, signal),
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
      (signal) => api.deselectSession(signal),
      "Failed to open New session",
      false,
      (snapshot) => snapshot.active === null,
    );
  }

  /** Creates a session without inventing a fallback project root. */
  async create(
    cwd?: string,
    options: NewSessionOptions = {},
  ): Promise<string | null> {
    const api = this.host.api();
    if (!api) return null;
    const target = cwd?.trim() || this.host.state().cwd;
    if (!target) {
      this.host.notify(
        "warning",
        "Enter a project directory to start a session",
      );
      return null;
    }
    // Creation has no receipt/retry identity. Never turn an unconfirmed write
    // into an ordinary retry button, including after navigation/reconnect.
    if (this.creation === "pending") return null;
    if (this.creation === "uncertain" && !this.host.confirmUncertainCreation())
      return null;
    this.creation = "pending";
    try {
      return await this.runSelection(
        null,
        api,
        async (signal) => {
          try {
            return await api.newSession(target, options, signal);
          } catch (error) {
            // A gateway/server timeout is not proof that no session exists.
            if (
              (error instanceof ApiRequestCancelledError &&
                !error.outcomeUnknown) ||
              (error instanceof ApiError &&
                !error.outcomeUnknown &&
                error.status < 500 &&
                error.status !== 408)
            )
              this.creation = null;
            throw error;
          }
        },
        "Failed to create session",
        null,
        (snapshot) => {
          this.creation = null;
          const sessionId = snapshot.active?.sessionId ?? null;
          if (sessionId) this.host.ensureSessionVisible(sessionId);
          if (options.model) this.host.rememberModel(options.model);
          this.host.refreshSessionCatalog();
          return sessionId;
        },
      );
    } finally {
      if (this.creation === "pending") this.creation = "uncertain";
    }
  }

  private async runSelection<T>(
    openingSessionId: string | null,
    api: Api,
    request: (signal: AbortSignal) => Promise<ActiveSnapshot>,
    fallbackMessage: string,
    staleResult: T,
    afterApply: (snapshot: ActiveSnapshot, ticket: number) => T,
  ): Promise<T> {
    const transportGeneration = this.host.transportGeneration();
    const ticket = this.host.beginOpening(openingSessionId);
    this.observation?.abort();
    const observation = new AbortController();
    this.observation = observation;
    try {
      const snapshot = await request(observation.signal);
      if (!this.host.ownsOpening(ticket, api, transportGeneration))
        return staleResult;
      this.host.applySnapshot(snapshot);
      this.host.setActionError(null);
      return afterApply(snapshot, ticket);
    } catch (error) {
      if (this.host.ownsOpening(ticket, api, transportGeneration)) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else {
          this.host.setActionError(
            error instanceof Error ? error.message : fallbackMessage,
          );
          if (error instanceof ApiError && error.code === "SESSION_NOT_FOUND")
            this.host.refreshSessionCatalog();
        }
      }
      return staleResult;
    } finally {
      if (this.observation === observation) this.observation = null;
      this.host.releaseOpening(ticket);
    }
  }
}
