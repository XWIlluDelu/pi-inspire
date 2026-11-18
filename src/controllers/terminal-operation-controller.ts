import type { MatchedReceipt } from "../../shared/host-operations";
import {
  TERMINAL_OPERATIONS_PATH,
  type TerminalIntent,
  type TerminalOperation,
  type TerminalOperationResults,
  terminalIntentSchema,
  terminalOperationIdentitySchema,
  terminalOperationSchema,
  terminalReceiptIdentity,
} from "../../shared/terminal-operations";
import { request } from "../http-request";
import { ReceiptRead } from "../operation-observer";
import { receiptStorage } from "../receipt-storage";

const STORAGE_KEY = "inspire:terminal-operations:v2";
const MAX_PENDING = 128;
// Allows maximum-length terminal names and fully JSON-escaped paths.
const MAX_STORAGE_CHARS = MAX_PENDING * 32 * 1024;
export class TerminalChangePending extends Error {}
interface TrackedOperation {
  operation?: TerminalOperation;
  settled?: true;
  observation: ReceiptRead<string, unknown>;
}

function intentKey(intent: TerminalIntent): string {
  return JSON.stringify(intent);
}

const savedOperations = terminalOperationSchema
  .array()
  .max(MAX_PENDING)
  .refine(
    (entries) =>
      new Set(entries.map(({ intent }) => intentKey(intent))).size ===
        entries.length &&
      new Set(
        entries.map(
          ({ executor, operationId }) => `${executor.epoch}:${operationId}`,
        ),
      ).size === entries.length,
  );

/** The terminal daemon owns execution. The browser remembers which operation to observe. */
export class TerminalOperationController {
  private readonly operations = new Map<string, TrackedOperation>();
  private loaded = false;
  private readonly tracking: ReturnType<
    typeof receiptStorage<TerminalOperation[]>
  >;

  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    storage: () => Storage = () => sessionStorage,
  ) {
    this.tracking = receiptStorage(
      MAX_STORAGE_CHARS,
      savedOperations.parse,
      [],
      storage,
    );
  }

  private restore(): void {
    if (this.loaded) return;
    const saved = this.tracking.read(STORAGE_KEY);
    if (saved.issue)
      throw new Error("Open Inspire in a new tab to manage terminals.");
    for (const operation of saved.value)
      this.operations.set(intentKey(operation.intent), {
        operation,
        observation: new ReceiptRead(),
      });
    this.loaded = true;
  }

  async resume(): Promise<void> {
    try {
      this.restore();
    } catch {
      return;
    }
    await Promise.allSettled(
      [...this.operations.values()].flatMap(({ operation, settled }) =>
        operation && !settled ? [this.dispatch(operation.intent, false)] : [],
      ),
    );
  }

  run<I extends TerminalIntent>(
    intent: I,
  ): Promise<TerminalOperationResults[I["command"]]> {
    try {
      this.restore();
      return this.dispatch<TerminalOperationResults[I["command"]]>(
        terminalIntentSchema.parse(intent),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private dispatch<T>(intent: TerminalIntent, requested = true): Promise<T> {
    const key = intentKey(intent);
    const tracked = this.operations.get(key) ?? {
      observation: new ReceiptRead<string, unknown>(),
    };
    if (tracked.observation.task) return tracked.observation.task as Promise<T>;
    if (tracked.settled) this.removeOperation(tracked);
    if (!tracked.operation && this.operations.size >= MAX_PENDING)
      return Promise.reject(
        new Error("Terminal controls are temporarily unavailable."),
      );
    const task = tracked.observation.observe(
      key,
      () => this.deliver<T>(tracked, intent, requested),
      () => {
        if (!tracked.operation) this.operations.delete(key);
      },
    );
    this.operations.set(key, tracked);
    return task as Promise<T>;
  }

  private removeOperation(tracked: TrackedOperation): void {
    tracked.settled = true;
    this.persist();
    delete tracked.operation;
    delete tracked.settled;
  }

  private async deliver<T>(
    tracked: TrackedOperation,
    intent: TerminalIntent,
    requested: boolean,
  ): Promise<T> {
    const previous = tracked.operation;
    if (!previous) {
      const { epoch } = await request<{ epoch?: unknown }>(
        TERMINAL_OPERATIONS_PATH,
        {},
        { timeoutMs: 10_000 },
        this.transport,
      );
      const identity = terminalOperationIdentitySchema.parse({
        executor: { kind: "terminal", epoch },
        operationId: crypto.randomUUID(),
      });
      tracked.operation = { ...identity, intent };
      try {
        this.persist();
      } catch (error) {
        delete tracked.operation;
        throw error;
      }
    }
    const operation = tracked.operation!;
    const identity = terminalReceiptIdentity(operation);
    const read = (observe: boolean) =>
      request<MatchedReceipt>(
        observe
          ? `${TERMINAL_OPERATIONS_PATH}?observe=1`
          : TERMINAL_OPERATIONS_PATH,
        { method: "POST", body: JSON.stringify(operation) },
        { timeoutMs: 20_000, matchReceipt: identity },
        this.transport,
      ).catch(() => null);
    let receipt = await read(Boolean(previous));
    if (
      !previous &&
      (!receipt || receipt.state === "pending" || receipt.state === "unknown")
    )
      receipt = await read(true);
    else if (
      requested &&
      receipt?.state === "unknown" &&
      receipt.error.code === "terminal_operation_missing"
    )
      receipt = await read(false); // Same ID; the daemon can admit it at most once.

    if (
      receipt?.state === "completed" ||
      receipt?.state === "rejected" ||
      (receipt?.state === "unknown" &&
        (receipt.error.code === "terminal_operation_expired" ||
          receipt.error.code === "terminal_operation_epoch_changed"))
    ) {
      try {
        this.removeOperation(tracked);
      } catch {
        // Keep the authoritative result even if local storage is unavailable.
      }
    }
    if (receipt?.state === "rejected") throw new Error(receipt.error.message);
    if (receipt?.state !== "completed")
      throw new TerminalChangePending("Couldn’t confirm the terminal change.");
    return receipt.result as T;
  }

  private persist(): void {
    this.tracking.write(
      STORAGE_KEY,
      [...this.operations.values()].flatMap((record) =>
        !record.settled && record.operation ? [record.operation] : [],
      ),
    );
  }
}

export const terminalOperations = new TerminalOperationController();
