import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../api";

interface Handoff {
  intent: string;
  request: PendingOperationRequest;
  result?: PendingRecovery;
  completion: Promise<PendingRecovery>;
  complete(result: PendingRecovery): void;
  fail(error: ApiError): void;
  observation?: {
    api: Api;
    promise: Promise<PendingRecovery>;
  };
  restored?: boolean;
}
interface PendingRecoveryHost {
  api(): Api | null;
  authorityId(): string | null;
  restore(sessionId: string, recovery: PendingRecovery): boolean;
  handleAuthFailure(): void;
}

/** Retains unclaimed handoff identities, not Pending input or execution order. */
export class PendingRecoveryController {
  private readonly handoffs = new Map<string, Handoff>();
  private readonly runs = new Map<string, number>();
  private readonly queues = new Map<string, number>();
  constructor(private readonly host: PendingRecoveryHost) {}

  async run(
    sessionId: string,
    action: PendingOperationRequest["action"],
    expectedViewId?: string,
  ): Promise<boolean> {
    const authorityId = this.host.authorityId();
    if (!authorityId || !this.host.api()) return false;
    const intent = JSON.stringify([
      authorityId,
      sessionId,
      action,
      expectedViewId,
      this.runs.get(sessionId) ?? 0,
      action === "recover" ? (this.queues.get(sessionId) ?? 0) : null,
    ]);
    let handoff = this.handoffs.get(intent);
    if (!handoff) {
      let complete!: Handoff["complete"];
      let fail!: Handoff["fail"];
      const completion = new Promise<PendingRecovery>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      handoff = {
        intent,
        request: {
          sessionId,
          action,
          authorityId,
          ...(expectedViewId ? { expectedViewId } : {}),
          operationId: crypto.randomUUID(),
        },
        completion,
        complete,
        fail,
      };
      this.handoffs.set(intent, handoff);
    }
    this.resume(handoff);
    return this.observe(handoff, false);
  }

  private terminal(error: ApiError, request: PendingOperationRequest): boolean {
    return (
      error.authorityId === request.authorityId &&
      error.pendingReceipt?.operationId === request.operationId &&
      (error.pendingReceipt.outcome === "failed" ||
        error.pendingReceipt.outcome === "retired")
    );
  }

  private owns(handoff: Handoff): boolean {
    return this.handoffs.get(handoff.intent) === handoff;
  }

  private async observe(handoff: Handoff, readOnly: boolean): Promise<boolean> {
    const api = this.host.api();
    if (!api || handoff.request.authorityId !== this.host.authorityId())
      return false;
    const { request } = handoff;
    try {
      if (!handoff.result) {
        if (
          readOnly ||
          !handoff.observation ||
          handoff.observation.api !== api
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
                !this.owns(handoff) ||
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
            // A receipt observer can finish before the original POST. The
            // first confirmed result owns restoration; retired handoffs must
            // not be revived by late transport completions.
            if (this.owns(handoff) && !handoff.result) {
              handoff.result = result;
              handoff.complete(result);
            }
            return result;
          });
          handoff.observation = { api, promise };
        }
        const observation = handoff.observation;
        try {
          // Lightweight socket resume keeps the same API. Wake the
          // initiating Return/Stop too when another observer confirms it.
          await Promise.race([observation.promise, handoff.completion]);
        } finally {
          if (handoff.observation === observation)
            handoff.observation = undefined;
        }
      }
      if (
        api !== this.host.api() ||
        request.authorityId !== this.host.authorityId()
      )
        return false;
      if (handoff.restored === undefined) {
        if (!this.owns(handoff)) return false;
        handoff.restored = this.host.restore(
          request.sessionId,
          handoff.result!,
        );
        this.handoffs.delete(handoff.intent);
      }
      return handoff.restored;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.authorityId === request.authorityId &&
        (this.terminal(error, request) ||
          (!error.outcomeUnknown &&
            error.status !== 401 &&
            error.status < 500)) &&
        this.owns(handoff)
      ) {
        this.handoffs.delete(handoff.intent);
        handoff.fail(error);
      }
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
    for (const handoff of this.handoffs.values()) {
      if (handoff === except) continue;
      if (handoff.request.authorityId !== this.host.authorityId()) {
        this.handoffs.delete(handoff.intent);
        continue;
      }
      const api = this.host.api();
      void this.observe(handoff, true).catch((error) => {
        if (
          api === this.host.api() &&
          error instanceof ApiError &&
          error.status === 401
        )
          this.host.handleAuthFailure();
      });
    }
  }
}
