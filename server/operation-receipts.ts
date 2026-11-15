import type {
  HostOperationError,
  HostOperationCommand,
  HostOperationResults,
  OperationReceipt,
} from "../shared/host-operations.js";
import { requestError } from "./request-error.js";

type ReceiptIdentity<Executor, Command> = {
  executor: Executor;
  operationId: string;
  command: Command;
};

export async function settleOperation<Executor, Command, Result>(
  identity: ReceiptIdentity<Executor, Command>,
  execute: () => Promise<Result>,
  unknown: (
    error: HostOperationError & { outcomeUnknown?: boolean },
  ) => boolean,
  fallback = "Operation failed",
): Promise<OperationReceipt<Executor, Command, Result>> {
  try {
    return { ...identity, state: "completed", result: await execute() };
  } catch (error) {
    const detail = error as
      | (Partial<HostOperationError> & {
          outcomeUnknown?: boolean;
        })
      | null;
    const failure = {
      message: error instanceof Error ? error.message : fallback,
      status: detail?.status ?? 500,
      matches: detail?.matches,
      code: detail?.code,
      recoveredAttachments: detail?.recoveredAttachments,
      recoveryId: detail?.recoveryId,
    };
    return {
      ...identity,
      state: unknown({ ...failure, outcomeUnknown: detail?.outcomeUnknown })
        ? "unknown"
        : "rejected",
      error: failure,
    };
  }
}

interface Receipt<Result> {
  fingerprint: string;
  result: Promise<Result> | null;
  bytes: number;
}

/** Execution ownership stays with the caller. Retiring a result preserves
 * its identity until the caller can fence future admission for that key. */
export class ReceiptWindow<Result> {
  private readonly records = new Map<string, Receipt<Result>>();
  private readonly retained = new Map<string, number>();
  private readonly expiry = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly policy: {
      now: () => number;
      resultTtlMs: number;
      resultLimit: number;
      byteLimit: number;
      retirement?: { ttlMs: number; fence(): void };
      snapshot?: (result: Result, serialized: string | undefined) => Result;
    },
  ) {}

  get size(): number {
    return this.records.size;
  }

  get(key: string): Receipt<Result> | undefined {
    return this.records.get(key);
  }

  start(
    key: string,
    fingerprint: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    let bytes = 0;
    const task = Promise.resolve()
      .then(execute)
      .then((value) => {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(value);
        } catch (error) {
          if (this.policy.snapshot) throw error;
        }
        const result = this.policy.snapshot
          ? this.policy.snapshot(value, serialized)
          : value;
        bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized);
        return result;
      });
    const entry: Receipt<Result> = { fingerprint, result: task, bytes: 0 };
    this.records.set(key, entry);
    const settle = () => {
      const now = this.policy.now();
      this.retained.set(key, now);
      if (this.policy.retirement) this.expiry.set(key, now);
      this.bytes += bytes;
      entry.bytes = bytes;
      this.prune();
    };
    void task.then(settle, settle);
    return task;
  }

  forgetSettled(): void {
    this.forgetExpired(Infinity);
  }

  prune(): void {
    const now = this.policy.now();
    const { retirement, resultTtlMs, byteLimit, resultLimit } = this.policy;
    for (const [key, at] of this.retained) {
      if (
        this.bytes <= byteLimit &&
        this.retained.size <= resultLimit &&
        now - at < resultTtlMs &&
        (!retirement || now - at < retirement.ttlMs)
      )
        break;
      this.dropResult(key);
    }
    if (retirement) this.forgetExpired(now - retirement.ttlMs);
  }

  private dropResult(key: string): void {
    if (!this.retained.delete(key)) return;
    const receipt = this.records.get(key)!;
    this.bytes -= receipt.bytes;
    receipt.result = null;
  }

  private forgetExpired(cut: number): void {
    const retirement = this.policy.retirement;
    if (!retirement) return;
    // Capacity rejection closes the admission epoch even if all work is in flight.
    let fenced = cut === Infinity;
    if (fenced) retirement.fence();
    for (const [key, at] of this.expiry) {
      if (at > cut) break;
      if (!fenced) retirement.fence();
      fenced = true;
      this.dropResult(key);
      this.expiry.delete(key);
      this.records.delete(key);
    }
  }
}

/** All Host input commands share one process-lifetime ID namespace. */
export class HostOperationReceipts {
  private readonly receipts = new ReceiptWindow<
    HostOperationResults[HostOperationCommand]
  >({
    now: () => Date.now(),
    resultTtlMs: 15 * 60_000 + 1,
    resultLimit: 2_048,
    byteLimit: 32 * 1024 * 1024,
  });

  read<Command extends HostOperationCommand>(
    command: Command,
    id: string,
    fingerprint?: string,
    execute?: () => Promise<HostOperationResults[Command]>,
  ): Promise<HostOperationResults[Command]> {
    const group = command === "prompt" ? "PROMPT" : "PENDING";
    const refuse = (
      suffix: string,
      message: string,
      outcomeUnknown = !execute,
    ): never => {
      throw requestError(message, suffix === "CAPACITY" ? 503 : 409, {
        code: `${group}_OPERATION_${suffix}`,
        ...(outcomeUnknown && { outcomeUnknown: true }),
      });
    };
    const prefix = `${command}:`;
    this.receipts.prune();
    const previous = this.receipts.get(id);
    if (previous) {
      if (
        !previous.fingerprint.startsWith(prefix) ||
        (fingerprint !== undefined &&
          previous.fingerprint !== prefix + fingerprint)
      )
        refuse(
          "MISMATCH",
          "That operation ID belongs to a different input or action.",
        );
      if (!previous.result)
        refuse(
          "RESULT_RETIRED",
          "The original receipt retired. Inspect the conversation before trying again.",
          true,
        );
      return previous.result as Promise<HostOperationResults[Command]>;
    }
    if (!execute || fingerprint === undefined)
      return refuse(
        "NOT_FOUND",
        "This Host cannot identify that receipt.",
        true,
      );
    if (this.receipts.size >= 65_536)
      refuse(
        "CAPACITY",
        "This Host reached its input operation receipt limit.",
      );
    return this.receipts.start(id, prefix + fingerprint, execute) as Promise<
      HostOperationResults[Command]
    >;
  }
}
