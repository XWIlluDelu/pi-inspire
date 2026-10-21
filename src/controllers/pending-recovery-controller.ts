import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../api";

interface Handoff {
  request: PendingOperationRequest;
  result?: PendingRecovery;
  observation?: {
    api: Api;
    generation: number;
    promise: Promise<PendingRecovery>;
  };
  applied: boolean;
}
interface PendingRecoveryHost {
  api(): Api | null;
  authorityId(): string | null;
  transportGeneration(): number;
  restore(sessionId: string, recovery: PendingRecovery): boolean;
  handleAuthFailure(): void;
}

/** Retains unclaimed handoff identities, not Pending input or execution order. */
export class PendingRecoveryController {
  private readonly handoffs = new Map<string, Handoff>();
  private readonly intents = new Map<string, Handoff>();
  private readonly runs = new Map<string, number>();
  private readonly queues = new Map<string, number>();
  constructor(private readonly host: PendingRecoveryHost) {}

  async run(
    sessionId: string,
    action: PendingOperationRequest["action"],
  ): Promise<boolean> {
    const authorityId = this.host.authorityId();
    if (!authorityId || !this.host.api()) return false;
    const intent = JSON.stringify([
      authorityId,
      sessionId,
      action,
      this.runs.get(sessionId) ?? 0,
      action === "recover" ? (this.queues.get(sessionId) ?? 0) : null,
    ]);
    let handoff = this.intents.get(intent);
    if (!handoff) {
      handoff = {
        request: {
          sessionId,
          action,
          authorityId,
          operationId: crypto.randomUUID(),
        },
        applied: false,
      };
      this.intents.set(intent, handoff);
      this.handoffs.set(handoff.request.operationId, handoff);
    }
    this.resume(handoff);
    return this.observe(handoff.request.operationId, handoff, false);
  }

  private terminal(error: ApiError, request: PendingOperationRequest): boolean {
    return (
      error.authorityId === request.authorityId &&
      error.pendingReceipt?.operationId === request.operationId &&
      (error.pendingReceipt.outcome === "failed" ||
        error.pendingReceipt.outcome === "retired")
    );
  }

  private forget(key: string, handoff: Handoff): void {
    this.handoffs.delete(key);
    for (const [intent, current] of this.intents)
      if (current === handoff) this.intents.delete(intent);
  }

  private async observe(
    key: string,
    handoff: Handoff,
    readOnly: boolean,
  ): Promise<boolean> {
    const api = this.host.api();
    const generation = this.host.transportGeneration();
    if (!api || handoff.request.authorityId !== this.host.authorityId())
      return false;
    const { request } = handoff;
    try {
      if (!handoff.result) {
        if (
          readOnly ||
          !handoff.observation ||
          handoff.observation.api !== api ||
          handoff.observation.generation !== generation
        ) {
          const promise = (async () => {
            try {
              return await (readOnly
                ? api.pendingOperation(request)
                : request.action === "recover"
                  ? api.recoverPending(request.sessionId, request)
                  : api.abort(request.sessionId, request));
            } catch (error) {
              if (
                readOnly ||
                !(
                  error instanceof ApiTransportError ||
                  (error instanceof ApiError &&
                    !this.terminal(error, request) &&
                    (error.outcomeUnknown || error.status >= 500))
                )
              )
                throw error;
              return api.pendingOperation(request);
            }
          })().then((result) => {
            handoff.result = result;
            return result;
          });
          handoff.observation = { api, generation, promise };
        }
        const observation = handoff.observation;
        try {
          await observation.promise;
        } finally {
          if (handoff.observation === observation)
            handoff.observation = undefined;
        }
      }
      if (
        api !== this.host.api() ||
        generation !== this.host.transportGeneration() ||
        request.authorityId !== this.host.authorityId()
      )
        return false;
      if (handoff.applied) return !handoff.result!.error;
      const restored = this.host.restore(request.sessionId, handoff.result!);
      handoff.applied = true;
      this.forget(key, handoff);
      return restored;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.authorityId === request.authorityId &&
        (this.terminal(error, request) ||
          (!error.outcomeUnknown &&
            error.status !== 401 &&
            error.status < 500)) &&
        this.handoffs.get(key) === handoff
      )
        this.forget(key, handoff);
      throw error;
    }
  }

  startRun(sessionId: string): void {
    this.runs.set(sessionId, (this.runs.get(sessionId) ?? 0) + 1);
  }

  updateQueue(sessionId: string, revision: number, totalCount: number): void {
    // Our own clear is not a new Return intent. Newly admitted input is.
    if (totalCount > 0) this.queues.set(sessionId, revision);
  }

  /** Reconnect and later intent only observe older receipts; never redispatch them. */
  resume(except?: Handoff): void {
    for (const [key, handoff] of this.handoffs) {
      if (handoff === except) continue;
      if (handoff.request.authorityId !== this.host.authorityId()) {
        this.forget(key, handoff);
        continue;
      }
      const api = this.host.api();
      const generation = this.host.transportGeneration();
      void this.observe(key, handoff, true).catch((error) => {
        if (
          api === this.host.api() &&
          generation === this.host.transportGeneration() &&
          error instanceof ApiError &&
          error.status === 401
        )
          this.host.handleAuthFailure();
      });
    }
  }
}
