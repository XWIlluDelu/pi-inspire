import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../shared/contracts.js";
import { OperationReceipts } from "./operation-receipts.js";
import { requestError } from "./request-error.js";

function fingerprint({
  sessionId,
  action,
  expectedViewId,
}: PendingOperationRequest): string {
  return JSON.stringify([sessionId, action, expectedViewId]);
}

/** Observation receipts only; Pi and Runtime retain their existing queue authority. */
export class PendingOperationReceipts {
  private readonly receipts = new OperationReceipts<PendingRecovery>({
    message: "This Host has reached its Pending receipt limit",
    code: "PENDING_OPERATION_CAPACITY",
  });

  private find(
    request: PendingOperationRequest,
  ): Promise<PendingRecovery> | undefined {
    const receipt = this.receipts.get(request.operationId);
    if (!receipt) return;
    if (receipt.fingerprint !== fingerprint(request))
      throw requestError(
        "That Pending operation belongs to another session view or action",
        409,
        {
          code: "PENDING_OPERATION_MISMATCH",
        },
      );
    if (!receipt.result)
      throw requestError(
        "This Pending recovery receipt retired before it could be reclaimed",
        409,
        {
          code: "PENDING_OPERATION_RESULT_RETIRED",
          outcomeUnknown: true,
          pendingReceipt: {
            operationId: request.operationId,
            outcome: "retired",
          },
        },
      );
    return receipt.result;
  }

  observe(request: PendingOperationRequest): Promise<PendingRecovery> {
    const receipt = this.find(request);
    if (!receipt)
      throw requestError(
        "This Host cannot identify that Pending operation",
        409,
        {
          code: "PENDING_OPERATION_NOT_FOUND",
          outcomeUnknown: true,
        },
      );
    return receipt;
  }

  run(
    request: PendingOperationRequest,
    execute: () => Promise<PendingRecovery>,
  ): Promise<PendingRecovery> {
    const existing = this.find(request);
    if (existing) return existing;
    return this.receipts.start(
      request.operationId,
      fingerprint(request),
      async () => {
        try {
          return await execute();
        } catch (error) {
          throw Object.assign(
            new Error(
              error instanceof Error
                ? error.message
                : "Pending operation failed",
            ),
            error && typeof error === "object" ? error : {},
            {
              pendingReceipt: {
                operationId: request.operationId,
                outcome: "failed",
              },
            },
          );
        }
      },
    );
  }
}
