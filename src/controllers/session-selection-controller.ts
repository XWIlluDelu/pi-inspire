import type {
  ActiveSnapshot,
  ModelIdentity,
  NewSessionOptions,
  SessionReadOnlyReason,
} from "../../shared/contracts";
import { type Api, ApiError, ApiRequestCancelledError } from "../api";

export type SessionOpenResult = "opened" | "missing" | "retry" | "superseded";

interface SessionSelectionState {
  sessionId: string | null;
  cwd: string | null;
  openingSessionId: string | null;
  sessionSelectionPending: boolean;
  bootstrapped: boolean;
  readOnlyReason?: SessionReadOnlyReason | null;
}

interface SessionSelectionControllerHost {
  state(): SessionSelectionState;
  api(): Api | null;
  patch(state: {
    openingSessionId: string | null;
    sessionSelectionPending: boolean;
    startupPending?: false;
  }): void;
  onOpenIntent(): void;
  applySnapshot(snapshot: ActiveSnapshot): void;
  ensureSessionVisible(sessionId: string): void;
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
 * response while its explicit selection owner and API client still match.
 */
export class SessionSelectionController {
  private observation: AbortController | null = null;
  private creation: "pending" | "uncertain" | null = null;
  private request = 0;
  private intent = 0;

  constructor(private readonly host: SessionSelectionControllerHost) {}

  get generation(): number {
    return this.request;
  }

  /** Startup continuation yields only to an explicit open, new, or deselect. */
  get openIntent(): number {
    return this.intent;
  }

  beginForkSelection(): number {
    return ++this.request;
  }

  /** A replacement transport retires every in-flight selection. */
  invalidateForReplacement(): void {
    this.request++;
    this.releaseOpening();
  }

  private releaseOpening(owner?: AbortController): void {
    if (owner && owner !== this.observation) return;
    if (!owner) this.observation?.abort();
    this.observation = null;
    const state = this.host.state();
    if (state.sessionSelectionPending)
      this.host.patch({
        openingSessionId: null,
        sessionSelectionPending: false,
        ...(owner && state.bootstrapped ? { startupPending: false } : {}),
      });
  }

  async open(id: string): Promise<SessionOpenResult> {
    const state = this.host.state();
    const api = this.host.api();
    if (!api) return "retry";
    // Re-selecting the visible session is a no-op only with no older operation
    // to supersede, including create/deselect intents with no target ID yet.
    if (
      id === state.sessionId &&
      !state.sessionSelectionPending &&
      !state.readOnlyReason
    )
      return "opened";
    if (id === state.openingSessionId) return "superseded";
    return this.runSelection<SessionOpenResult>(
      id,
      api,
      (signal) => api.json("openSession", { body: { id } }, signal),
      "Failed to open session",
      "superseded",
      () => {
        this.host.ensureSessionVisible(id);
        return "opened";
      },
      (error) =>
        error instanceof ApiError && error.code === "SESSION_NOT_FOUND"
          ? "missing"
          : "retry",
    );
  }

  async deselect(): Promise<boolean> {
    const api = this.host.api();
    if (!api) return false;
    return this.runSelection(
      null,
      api,
      (signal) => api.json("deselectSession", {}, signal),
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
            return await api.json(
              "newSession",
              { body: { cwd: target, ...options } },
              signal,
            );
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
    afterApply: (snapshot: ActiveSnapshot) => T,
    onFailure?: (error: unknown) => T,
  ): Promise<T> {
    this.host.onOpenIntent();
    this.intent++;
    const ticket = ++this.request;
    this.observation?.abort();
    const observation = new AbortController();
    this.observation = observation;
    this.host.patch({ openingSessionId, sessionSelectionPending: true });
    const owns = () =>
      ticket === this.request &&
      this.observation === observation &&
      api === this.host.api();
    try {
      const snapshot = await request(observation.signal);
      if (!owns()) return staleResult;
      this.host.applySnapshot(snapshot);
      this.host.setActionError(null);
      return afterApply(snapshot);
    } catch (error) {
      if (owns()) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else {
          this.host.setActionError(
            error instanceof Error ? error.message : fallbackMessage,
          );
          if (error instanceof ApiError && error.code === "SESSION_NOT_FOUND")
            this.host.refreshSessionCatalog();
        }
        return onFailure?.(error) ?? staleResult;
      }
      return staleResult;
    } finally {
      this.releaseOpening(observation);
    }
  }
}
