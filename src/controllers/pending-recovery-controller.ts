import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../../shared/contracts";
import { type Api, ApiError, ApiTransportError } from "../api";
import { ReceiptRead } from "../operation-observer";

interface Handoff {
  intent: string;
  request: PendingOperationRequest;
  observation: ReceiptRead<Api, boolean>;
  confirmed?: PendingRecovery;
  settled: Promise<boolean>;
  complete: (value: boolean) => void;
  reject: (error: unknown) => void;
}
interface PendingRecoveryHost {
  api(): Api | null;
  authorityId(): string | null;
  restore(sessionId: string, recovery: PendingRecovery): boolean;
  handleAuthFailure(): void;
}

function createHandoff(
  intent: string,
  request: PendingOperationRequest,
): Handoff {
  let complete!: Handoff["complete"];
  let reject!: Handoff["reject"];
  const settled = new Promise<boolean>((resolve, refuse) => {
    complete = resolve;
    reject = refuse;
  });
  return {
    intent,
    request,
    observation: new ReceiptRead(),
    settled,
    complete,
    reject,
  };
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
    const api = this.host.api();
    if (!authorityId || !api) return false;
    const intent = JSON.stringify([
      authorityId,
      sessionId,
      action,
      expectedViewId,
      this.runs.get(sessionId) ?? 0,
      action === "recover" ? (this.queues.get(sessionId) ?? 0) : null,
    ]);
    const previous = this.handoffs.get(intent);
    const handoff =
      previous ??
      createHandoff(intent, {
        sessionId,
        action,
        authorityId,
        expectedViewId,
        operationId: crypto.randomUUID(),
      });
    if (!previous) this.handoffs.set(intent, handoff);
    this.resume(handoff);
    return this.observe(handoff, api, !previous);
  }

  private observe(
    handoff: Handoff,
    api: Api,
    dispatch = false,
  ): Promise<boolean> {
    const { intent, request, observation, settled, complete, reject } = handoff;
    const { authorityId, operationId, sessionId, action } = request;
    const current = () => this.handoffs.get(intent) === handoff;
    const rejected = (error: unknown): boolean =>
      error instanceof ApiError &&
      error.authorityId === authorityId &&
      error.operation?.operationId === operationId &&
      error.operation.command === action &&
      !error.outcomeUnknown;
    const read = () => api.pendingOperation(request);
    const task = observation.observe(api, async () => {
      try {
        const result =
          handoff.confirmed ??
          (await (dispatch
            ? (action === "recover"
                ? api.recoverPending(sessionId, request)
                : api.abort(sessionId, request)
              ).catch((error: unknown) => {
                if (
                  current() &&
                  (error instanceof ApiTransportError ||
                    (error instanceof ApiError &&
                      !rejected(error) &&
                      (error.outcomeUnknown || error.status >= 500)))
                )
                  return read();
                throw error;
              })
            : read()));
        handoff.confirmed ??= result;
      } catch (error) {
        if (!current()) return settled;
        if (!handoff.confirmed && rejected(error)) {
          this.handoffs.delete(intent);
          reject(error);
        }
        if (!handoff.confirmed) throw error;
      }
      if (!current()) return settled;
      if (api !== this.host.api() || authorityId !== this.host.authorityId())
        return false;
      this.handoffs.delete(intent);
      try {
        complete(this.host.restore(sessionId, handoff.confirmed));
      } catch (error) {
        reject(error);
      }
      return settled;
    });
    return Promise.race([task, settled]);
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
        handoff.complete(false);
        continue;
      }
      const api = this.host.api();
      if (!api) continue;
      // Observe even while the old POST is held. Either receipt can settle the handoff.
      handoff.observation.cancel();
      void this.observe(handoff, api).catch((error) => {
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
