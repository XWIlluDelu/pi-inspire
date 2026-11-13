import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../api";

import { OperationObserver } from "../operation-observer";

interface Handoff {
  intent: string;
  request: PendingOperationRequest;
  receipt: OperationObserver<Api, PendingRecovery>;
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
      handoff = {
        intent,
        request: {
          sessionId,
          action,
          authorityId,
          ...(expectedViewId ? { expectedViewId } : {}),
          operationId: crypto.randomUUID(),
        },
        receipt: new OperationObserver(),
      };
      this.handoffs.set(intent, handoff);
    }
    this.resume(handoff);
    return this.observe(handoff, false);
  }

  private terminal(error: ApiError, request: PendingOperationRequest): boolean {
    return (
      error.authorityId === request.authorityId &&
      error.operation?.operationId === request.operationId &&
      error.operation.command === request.action &&
      !error.outcomeUnknown
    );
  }

  private owns(handoff: Handoff): boolean {
    return this.handoffs.get(handoff.intent) === handoff;
  }

  private async observe(handoff: Handoff, readOnly: boolean): Promise<boolean> {
    const api = this.host.api();
    if (!api || handoff.request.authorityId !== this.host.authorityId())
      return false;
    const { request, receipt } = handoff;
    const rejected = (error: unknown) =>
      error instanceof ApiError && this.terminal(error, request);
    try {
      await receipt.observe(
        api,
        {
          start: () =>
            request.action === "recover"
              ? api.recoverPending(request.sessionId, request)
              : api.abort(request.sessionId, request),
          read: () => api.pendingOperation(request),
          rejected,
          recover: (error) =>
            this.owns(handoff) &&
            (error instanceof ApiTransportError ||
              (error instanceof ApiError &&
                !rejected(error) &&
                (error.outcomeUnknown || error.status >= 500))),
        },
        readOnly,
      );
    } catch (error) {
      if (rejected(error) && this.owns(handoff))
        this.handoffs.delete(handoff.intent);
      throw error;
    }
    if (
      api !== this.host.api() ||
      request.authorityId !== this.host.authorityId()
    )
      return false;
    if (handoff.restored !== undefined) return handoff.restored;
    if (!this.owns(handoff)) return false;
    const confirmed = receipt.claim();
    if (!confirmed) return false;
    handoff.restored = this.host.restore(request.sessionId, confirmed.value);
    this.handoffs.delete(handoff.intent);
    return handoff.restored;
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
