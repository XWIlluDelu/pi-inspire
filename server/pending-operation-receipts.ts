import type {
  PendingOperationRequest,
  PendingRecovery,
} from "../shared/contracts.js";
import { requestError } from "./request-error.js";

interface Receipt {
  sessionId: string;
  action: PendingOperationRequest["action"];
  result: Promise<PendingRecovery> | null;
  settledAt: number | null;
  bytes: number;
}

/** Observation receipts only; Pi and Runtime retain their existing queue authority. */
export class PendingOperationReceipts {
  private readonly receipts = new Map<string, Receipt>();
  private readonly settled: Receipt[] = [];
  private bytes = 0;

  private retire(): void {
    while (this.settled.length) {
      const first = this.settled[0]!;
      if (
        this.settled.length <= 2_048 &&
        this.bytes <= 32 * 1024 * 1024 &&
        Date.now() - first.settledAt! <= 15 * 60_000
      )
        break;
      this.settled.shift();
      this.bytes -= first.bytes;
      first.bytes = 0;
      first.result = null;
    }
  }

  private find(request: PendingOperationRequest): Receipt | undefined {
    this.retire();
    const receipt = this.receipts.get(request.operationId);
    if (
      receipt &&
      (receipt.sessionId !== request.sessionId ||
        receipt.action !== request.action)
    )
      throw requestError(
        "That Pending operation belongs to another session or action",
        409,
        {
          code: "PENDING_OPERATION_MISMATCH",
        },
      );
    if (receipt && !receipt.result)
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
    return receipt;
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
    return receipt.result!;
  }

  run(
    request: PendingOperationRequest,
    execute: () => Promise<PendingRecovery>,
  ): Promise<PendingRecovery> {
    const existing = this.find(request);
    if (existing) return existing.result!;
    if (this.receipts.size >= 65_536)
      throw requestError(
        "This Host has reached its Pending receipt limit",
        503,
        {
          code: "PENDING_OPERATION_CAPACITY",
        },
      );
    const receipt: Receipt = {
      sessionId: request.sessionId,
      action: request.action,
      result: null,
      settledAt: null,
      bytes: 0,
    };
    const result = Promise.resolve()
      .then(execute)
      .catch((error: unknown) => {
        throw Object.assign(
          new Error(
            error instanceof Error ? error.message : "Pending operation failed",
          ),
          error && typeof error === "object" ? error : {},
          {
            pendingReceipt: {
              operationId: request.operationId,
              outcome: "failed",
            },
          },
        );
      });
    receipt.result = result;
    this.receipts.set(request.operationId, receipt);
    const settled = (bytes: number) => {
      receipt.settledAt = Date.now();
      receipt.bytes = bytes;
      this.bytes += bytes;
      this.settled.push(receipt);
      this.retire();
    };
    void result.then(
      (value) => settled(Buffer.byteLength(JSON.stringify(value))),
      () => settled(0),
    );
    return result;
  }
}
