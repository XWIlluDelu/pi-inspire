import type {
  ActiveSnapshot,
  ModelIdentity,
  NewSessionOptions,
  SessionReadOnlyReason,
} from "../../shared/contracts";
import type { HostOperationIdentity } from "../../shared/host-operations";
import { type Api, ApiError, ApiRequestCancelledError } from "../api";
import { isTransientFailure } from "../recovery-backoff";

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
  authorityId(): string | null;
  patch(state: {
    openingSessionId?: string | null;
    sessionSelectionPending?: boolean;
    startupPending?: false;
    sessionActionError?: string | null;
  }): void;
  onOpenIntent(): void;
  applySnapshot(snapshot: ActiveSnapshot): void;
  ensureSessionVisible(sessionId: string): void;
  rememberModel(model: ModelIdentity): void;
  refreshSessionCatalog(): void;
  notify(kind: "warning", text: string): void;
  handleAuthFailure(): void;
}

function uncertainCreation(error: unknown): boolean {
  if (error instanceof ApiRequestCancelledError) return error.outcomeUnknown;
  if (!(error instanceof ApiError)) return true;
  if (
    error.code === "SESSION_CREATION_FAILED" ||
    error.code === "SESSION_CREATION_OPERATION_RESULT_RETIRED"
  )
    return false;
  return error.outcomeUnknown || isTransientFailure(error);
}

/**
 * Owns open/new/deselect request ownership. AppStore remains the only session
 * snapshot and cross-domain commit facade; this controller only accepts a
 * response while its explicit selection owner and API client still match.
 */
export class SessionSelectionController {
  private observation: AbortController | null = null;
  private readonly creations = new Map<
    string,
    HostOperationIdentity & { pending: boolean }
  >();
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
    const authorityId = this.host.authorityId();
    if (!api || !authorityId) return null;
    const target = cwd?.trim() || this.host.state().cwd;
    if (!target) {
      this.host.notify(
        "warning",
        "Enter a project directory to start a session",
      );
      return null;
    }
    const key = JSON.stringify([target, options]);
    const previous = this.creations.get(key);
    if (previous?.authorityId === authorityId && previous.pending) return null;
    const receipt = {
      operationId:
        previous?.authorityId === authorityId
          ? previous.operationId
          : crypto.randomUUID(),
      authorityId,
    };
    const creation = { ...receipt, pending: true };
    this.creations.set(key, creation);
    try {
      return await this.runSelection(
        null,
        api,
        async (signal) => {
          const request = () =>
            api.json(
              "newSession",
              { body: { cwd: target, ...options, receipt } },
              signal,
            );
          const retire = () => {
            if (this.creations.get(key) === creation) this.creations.delete(key);
          };
          try {
            const snapshot = await request().catch((error) => {
              if (signal.aborted || !uncertainCreation(error)) throw error;
              return request();
            });
            retire();
            return snapshot;
          } catch (error) {
            if (!uncertainCreation(error)) {
              retire();
              throw error;
            }
            throw new Error("Couldn’t open the new session. Try again.");
          }
        },
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
    } finally {
      creation.pending = false;
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
      this.host.patch({ sessionActionError: null });
      return afterApply(snapshot);
    } catch (error) {
      if (owns()) {
        if (error instanceof ApiError && error.status === 401)
          this.host.handleAuthFailure();
        else {
          this.host.patch({
            sessionActionError:
              error instanceof Error ? error.message : fallbackMessage,
          });
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
