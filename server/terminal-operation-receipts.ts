import { createHash, randomUUID } from "node:crypto";
import type { TerminalOperationIdentity } from "../shared/terminal-contracts.js";
import { TerminalServiceError } from "./terminal-service.js";

interface Receipt {
  fingerprint: string;
  pending: boolean;
  completedAt: number;
  bytes: number;
  result?: Promise<unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Receipts survive disconnected callers, not daemon replacement. Expired
 * results become tombstones. Before forgetting a tombstone we fence its entire
 * admission epoch, so an unknown old ID can never become new work again. */
export class TerminalOperationReceipts {
  private epoch = randomUUID();
  private readonly receipts = new Map<string, Receipt>();

  constructor(
    private readonly options: {
      limit?: number;
      resultTtlMs?: number;
      tombstoneTtlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  getEpoch(): string {
    this.prune();
    return this.epoch;
  }

  run(
    operation: TerminalOperationIdentity | undefined,
    method: string,
    params: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    this.prune();
    if (
      !operation ||
      typeof operation.id !== "string" ||
      typeof operation.epoch !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(operation.id) ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(operation.epoch)
    )
      return this.refuse(
        "terminal_operation_required",
        "A terminal operation identity is required.",
      );
    const key = `${operation.epoch}:${operation.id}`;
    const fingerprint = createHash("sha256")
      .update(canonical([method, params]))
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
    if (operation.epoch !== this.epoch)
      return this.refuse(
        "terminal_operation_epoch_changed",
        "The terminal receipt epoch changed. The previous outcome is unknown; inspect the catalog before starting a new intent.",
      );
    if (this.receipts.size >= (this.options.limit ?? 2_048)) {
      // Never evict running work. Fence admission before reclaiming settled
      // receipts, including any ID whose result a disconnected caller lost.
      this.epoch = randomUUID();
      for (const [id, receipt] of this.receipts)
        if (!receipt.pending) this.receipts.delete(id);
      return this.refuse(
        "terminal_operation_capacity",
        "Terminal receipt capacity reached. This operation was not admitted.",
      );
    }
    const receipt: Receipt = {
      fingerprint,
      pending: true,
      completedAt: 0,
      bytes: 0,
    };
    this.receipts.set(key, receipt);
    receipt.result = Promise.resolve()
      .then(execute)
      .then((result) => {
        // Serialize now: subsequent service mutations must not change a receipt.
        const serialized = JSON.stringify(result);
        if (serialized && Buffer.byteLength(serialized) > 256 * 1024)
          throw new TerminalServiceError(
            "terminal_operation_expired",
            409,
            "The terminal result exceeds the receipt limit. Inspect the catalog; this operation will not run again.",
          );
        receipt.bytes = serialized ? Buffer.byteLength(serialized) : 0;
        return serialized === undefined ? undefined : JSON.parse(serialized);
      })
      .finally(() => {
        receipt.pending = false;
        receipt.completedAt = this.now();
        let bytes = [...this.receipts.values()].reduce(
          (sum, item) => sum + item.bytes,
          0,
        );
        for (const item of this.receipts.values()) {
          if (bytes <= 16 * 1024 * 1024) break;
          if (item.pending) continue;
          bytes -= item.bytes;
          item.bytes = 0;
          item.result = undefined;
        }
      });
    return receipt.result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    let fenced = false;
    for (const [key, receipt] of this.receipts) {
      if (receipt.pending) continue;
      const age = now - receipt.completedAt;
      if (age >= (this.options.tombstoneTtlMs ?? 60 * 60_000)) {
        if (!fenced) {
          this.epoch = randomUUID();
          fenced = true;
        }
        this.receipts.delete(key);
      } else if (age >= (this.options.resultTtlMs ?? 10 * 60_000)) {
        receipt.result = undefined;
        receipt.bytes = 0;
      }
    }
  }

  private refuse(code: string, message: string): Promise<never> {
    return Promise.reject(new TerminalServiceError(code, 409, message));
  }
}
