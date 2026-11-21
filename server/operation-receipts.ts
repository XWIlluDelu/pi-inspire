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
  unknown: (error: HostOperationError & { outcomeUnknown?: boolean }) => boolean,
  fallback = "Operation failed",
): Promise<OperationReceipt<Executor, Command, Result>> {
  try {
    return { ...identity, state: "completed", result: await execute() };
  } catch (error) {
    const detail = error as (Partial<HostOperationError> & {
      outcomeUnknown?: boolean;
    }) | null;
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
}

type SettledReceipt<Result> = Receipt<Result> & { at: number; bytes: number };

/** Execution ownership stays with the caller. Retiring a result preserves
 * its identity until the caller can fence future admission for that key. */
export class ReceiptWindow<Result> {
  private readonly pending = new Map<string, Receipt<Result>>();
  private readonly retained = new Map<string, SettledReceipt<Result>>();
  private readonly retired = new Map<string, SettledReceipt<Result>>();
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
    return this.pending.size + this.retained.size + this.retired.size;
  }

  get(key: string): Receipt<Result> | undefined {
    return (
      this.pending.get(key) ?? this.retained.get(key) ?? this.retired.get(key)
    );
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
    this.pending.set(key, { fingerprint, result: task });
    const settle = () => {
      this.pending.delete(key);
      this.retained.set(key, {
        fingerprint,
        result: task,
        bytes,
        at: this.policy.now(),
      });
      this.bytes += bytes;
      this.prune();
    };
    void task.then(settle, settle);
    return task;
  }

  forgetSettled(): void {
    if (!this.policy.retirement) return;
    this.policy.retirement.fence();
    this.retained.clear();
    this.retired.clear();
    this.bytes = 0;
  }

  prune(): void {
    const now = this.policy.now();
    const { retirement, resultTtlMs, byteLimit, resultLimit } = this.policy;
    for (const [key, entry] of this.retained) {
      if (
        this.bytes <= byteLimit &&
        this.retained.size <= resultLimit &&
        now - entry.at < resultTtlMs &&
        (!retirement || now - entry.at < retirement.ttlMs)
      )
        break;
      this.retained.delete(key);
      this.bytes -= entry.bytes;
      entry.result = null;
      this.retired.set(key, entry);
    }
    if (!retirement) return;
    let fenced = false;
    for (const [key, entry] of this.retired) {
      if (now - entry.at < retirement.ttlMs) break;
      if (!fenced) retirement.fence();
      fenced = true;
      this.retired.delete(key);
    }
  }
}

/** All Host input commands share one process-lifetime ID namespace. */
export class HostOperationReceipts {
  private readonly receipts = new ReceiptWindow<HostOperationResults[HostOperationCommand]>({
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
    const group = command === "create" ? "SESSION_CREATION" : command === "prompt" ? "PROMPT" : "PENDING";
    const refuse = (suffix: string, message: string, outcomeUnknown = !execute): never => {
      throw requestError(message, suffix === "CAPACITY" ? 503 : 409, {
        code: `${group}_OPERATION_${suffix}`,
        ...(outcomeUnknown && { outcomeUnknown: true }),
      });
    };
    const prefix = `${command}:`;
    this.receipts.prune();
    const previous = this.receipts.get(id);
    if (previous) {
      if (!previous.fingerprint.startsWith(prefix) ||
          (fingerprint !== undefined && previous.fingerprint !== prefix + fingerprint))
        refuse("MISMATCH", "That operation ID belongs to a different input or action.");
      if (!previous.result)
        refuse("RESULT_RETIRED", command === "create"
          ? "Couldn’t open the new session. Try again."
          : "The original receipt retired. Inspect the conversation before trying again.", true);
      return previous.result as Promise<HostOperationResults[Command]>;
    }
    if (!execute || fingerprint === undefined)
      return refuse("NOT_FOUND", "This Host cannot identify that receipt.", true);
    if (this.receipts.size >= 65_536)
      refuse("CAPACITY", "This Host reached its input operation receipt limit.");
    return this.receipts.start(id, prefix + fingerprint, execute) as Promise<HostOperationResults[Command]>;
  }
}
