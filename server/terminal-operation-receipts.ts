import { createHash, randomUUID } from "node:crypto";
import type { TerminalOperation } from "../shared/terminal-operations.js";
import { ReceiptWindow } from "./operation-receipts.js";
import { canonicalPersistedJson } from "./persisted-json.js";
import { TerminalServiceError } from "./terminal-service.js";

/** Receipts survive disconnected callers, not daemon replacement. Expired
 * results become tombstones. Before forgetting a tombstone we fence its entire
 * admission epoch, so an unknown old ID can never become new work again. */
export class TerminalOperationReceipts {
  private epoch = randomUUID();
  private readonly receipts: ReceiptWindow<unknown>;

  constructor(
    private readonly options: {
      limit?: number;
      resultTtlMs?: number;
      tombstoneTtlMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.receipts = new ReceiptWindow({
      now: () => options.now?.() ?? Date.now(),
      resultTtlMs: options.resultTtlMs ?? 10 * 60_000,
      resultLimit: Infinity,
      byteLimit: 16 * 1024 * 1024,
      retirement: {
        ttlMs: options.tombstoneTtlMs ?? 60 * 60_000,
        fence: () => {
          this.epoch = randomUUID();
        },
      },
      snapshot: (_result, serialized) => {
        if (serialized && Buffer.byteLength(serialized) > 256 * 1024)
          throw new TerminalServiceError(
            "terminal_operation_expired",
            409,
            "The terminal result exceeds the receipt limit. Inspect the catalog; this operation will not run again.",
          );
        return serialized === undefined ? undefined : JSON.parse(serialized);
      },
    });
  }

  getEpoch(): string {
    this.receipts.prune();
    return this.epoch;
  }

  run(
    operation: TerminalOperation,
    execute?: () => Promise<unknown>,
  ): Promise<unknown> {
    this.receipts.prune();
    const {
      executor: { epoch },
      operationId,
      intent,
    } = operation;
    const key = `${epoch}:${operationId}`;
    const fingerprint = createHash("sha256")
      .update(canonicalPersistedJson(intent))
      .digest("hex");
    const prior = this.receipts.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        return this.refuse(
          "terminal_operation_mismatch",
          "This terminal operation identity belongs to different content.",
        );
      return (
        prior.result ??
        this.refuse(
          "terminal_operation_expired",
          "The terminal result has expired. Inspect the terminal catalog; this operation will not run again.",
        )
      );
    }
    if (epoch !== this.epoch)
      return this.refuse(
        "terminal_operation_epoch_changed",
        "The terminal receipt epoch changed. The previous outcome is unknown; inspect the catalog before starting a new intent.",
      );
    if (!execute)
      return this.refuse(
        "terminal_operation_missing",
        "The daemon has no receipt for this operation. No terminal control was sent.",
      );
    if (this.receipts.size >= (this.options.limit ?? 2_048)) {
      // Never evict running work. Fence admission before reclaiming settled
      // receipts, including any ID whose result a disconnected caller lost.
      this.receipts.forgetSettled();
      return this.refuse(
        "terminal_operation_capacity",
        "Terminal receipt capacity reached. This operation was not admitted.",
      );
    }
    return this.receipts.start(key, fingerprint, execute);
  }

  private refuse(code: string, message: string): Promise<never> {
    return Promise.reject(new TerminalServiceError(code, 409, message));
  }
}
