import { matchOperationReceipt } from "../../shared/host-operations";
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
import { authenticatedFetch } from "../browser-auth";
import { receiptStorage } from "../receipt-storage";

const STORAGE_KEY = "inspire:terminal-operations:v2";
const RETIRED_STORAGE_KEY = "inspire:terminal-operations:v1";
const MAX_PENDING = 128;
// Allows maximum-length terminal names and fully JSON-escaped paths.
const MAX_STORAGE_CHARS = MAX_PENDING * 32 * 1024;
type RecoveryOutcome = "unknown" | "completed" | "rejected";
interface TrackedOperation {
  operation?: TerminalOperation;
  outcome?: RecoveryOutcome;
  task?: Promise<unknown>;
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

interface TerminalRecoveryRow {
  key: string;
  label: string;
  busy: boolean;
  outcome: RecoveryOutcome;
  canRetry: boolean;
}

function operationLabel(intent: TerminalIntent): string {
  const label = {
    create: "Create terminal",
    rename: "Rename terminal",
    reorder: "Reorder terminals",
    restart: "Restart terminal",
    remove: "Close terminal",
    updateSettings: "Terminal settings",
    clearHistory: "Clear terminal history",
  }[intent.command];
  const target =
    intent.command === "create"
      ? intent.params.request.cwd
      : intent.command === "reorder"
        ? intent.params.projectCwd
        : "id" in intent.params
          ? intent.params.id
          : "";
  return target ? `${label} · ${target}` : label;
}

/** Browser-owned delivery identity, never terminal/process authority. Unknown
 * writes survive pane generations and page reload. Receipts settle results;
 * explicitly stopping tracking retires only the browser intent, not the work. */
export class TerminalOperationController {
  private operations = new Map<string, TrackedOperation>();
  private readonly listeners = new Set<() => void>();
  private state: TerminalRecoveryRow[] = [];
  private recoveryState: "unread" | "current" | "retired" = "unread";
  private readonly tracking: ReturnType<
    typeof receiptStorage<TerminalOperation[]>
  >;

  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private readonly storage: () => Storage = () => sessionStorage,
  ) {
    this.tracking = receiptStorage(
      MAX_STORAGE_CHARS,
      savedOperations.parse,
      [],
      storage,
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): TerminalRecoveryRow[] => this.state;

  restore(): void {
    if (this.recoveryState !== "unread") return;
    // Storage failure must not silently discard uncertain identities.
    const storage = this.storage();
    const retired = storage.getItem(RETIRED_STORAGE_KEY);
    const saved = this.tracking.read(STORAGE_KEY);
    if (saved.issue === "storage") throw saved.error;
    if (saved.issue)
      throw new Error(
        "Terminal operation storage is invalid; controls are blocked.",
      );
    this.operations = new Map(
      saved.value.map((operation) => [
        intentKey(operation.intent),
        { operation, outcome: "unknown" },
      ]),
    );
    this.recoveryState =
      retired !== null && retired !== "[]" ? "retired" : "current";
    this.publish();
  }

  run<I extends TerminalIntent>(
    intent: I,
  ): Promise<TerminalOperationResults[I["command"]]> {
    try {
      this.restore();
      if (this.recoveryState === "retired")
        throw new Error(
          "Check your terminals and stop tracking the previous version’s operations before sending new controls.",
        );
      return this.dispatch<TerminalOperationResults[I["command"]]>(
        terminalIntentSchema.parse(intent),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private dispatch<T>(intent: TerminalIntent): Promise<T> {
    const key = intentKey(intent);
    const tracked = this.operations.get(key) ?? {};
    if (tracked.task) return tracked.task as Promise<T>;
    if (!tracked.operation && this.operations.size >= MAX_PENDING)
      return Promise.reject(
        new Error(
          "Too many unresolved terminal operations. Resolve existing operations first.",
        ),
      );
    // A confirmed result makes another click a new intent, not a replay.
    // Retire its stored recovery record before admitting that new intent.
    if (tracked.outcome && tracked.outcome !== "unknown")
      this.removeOperation(tracked);
    const task = Promise.resolve()
      .then(() => this.deliver<T>(tracked, intent))
      .finally(() => {
        delete tracked.task;
        if (!tracked.operation) this.operations.delete(key);
        this.publish();
      });
    tracked.task = task;
    this.operations.set(key, tracked);
    this.publish();
    return task;
  }

  async retry(key: string): Promise<unknown> {
    this.restore();
    const tracked = this.operations.get(key);
    if (tracked?.task) return tracked.task;
    if (tracked?.outcome === "unknown")
      return this.dispatch(tracked.operation!.intent);
    if (tracked?.operation) this.stopTracking(key);
  }

  /** Retire a recovery record; never dispatch or claim cancellation. */
  stopTracking(key: string): void {
    this.restore();
    if (key === RETIRED_STORAGE_KEY && this.recoveryState === "retired") {
      this.storage().removeItem(RETIRED_STORAGE_KEY);
      this.recoveryState = "current";
      this.publish();
      return;
    }
    const tracked = this.operations.get(key);
    if (tracked?.task)
      throw new Error(
        "Wait for the current terminal operation check to finish.",
      );
    if (!tracked?.operation) return;
    this.removeOperation(tracked);
    this.operations.delete(key);
    this.publish();
  }

  private removeOperation(tracked: TrackedOperation): void {
    this.persist(tracked);
    delete tracked.operation;
    delete tracked.outcome;
  }

  private async deliver<T>(
    tracked: TrackedOperation,
    intent: TerminalIntent,
  ): Promise<T> {
    const previous = tracked.operation;
    if (!previous) {
      const response = await authenticatedFetch(
        TERMINAL_OPERATIONS_PATH,
        {
          signal: AbortSignal.timeout(10_000),
        },
        this.transport,
      );
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const reason =
          typeof problem?.error === "string"
            ? problem.error.slice(0, 1000)
            : "Terminal operation receipts are unavailable.";
        throw new Error(`${reason} No terminal control was sent.`);
      }
      const { epoch } = (await response.json()) as { epoch?: unknown };
      const identity = terminalOperationIdentitySchema.safeParse({
        executor: { kind: "terminal", epoch },
        operationId: crypto.randomUUID(),
      });
      if (!identity.success)
        throw new Error(
          "Terminal operation epoch is invalid. No terminal control was sent.",
        );
      tracked.operation = { ...identity.data, intent };
      try {
        this.persist();
      } catch (error) {
        delete tracked.operation;
        throw error;
      }
    }
    tracked.outcome = "unknown";
    const operation = tracked.operation!;
    try {
      const response = await authenticatedFetch(
        previous
          ? `${TERMINAL_OPERATIONS_PATH}?observe=1`
          : TERMINAL_OPERATIONS_PATH,
        {
          method: "POST",
          body: JSON.stringify(operation),
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20_000),
        },
        this.transport,
      );
      const receipt = matchOperationReceipt(
        await response.json(),
        terminalReceiptIdentity(operation),
      );
      const message =
        receipt?.state === "rejected" || receipt?.state === "unknown"
          ? receipt.error.message
          : undefined;
      const completed = receipt?.state === "completed" && response.ok;
      const rejected =
        receipt?.state === "rejected" &&
        !response.ok &&
        receipt.error.status === response.status &&
        Boolean(message);
      if (completed || rejected) {
        try {
          this.removeOperation(tracked);
        } catch {
          // Local bookkeeping failure cannot undo the daemon's confirmed result.
          // Keep the identity for cleanup without reporting an unknown operation.
          tracked.outcome = completed ? "completed" : "rejected";
        }
        if (completed) return receipt.result as T;
        throw new TerminalDefiniteRefusal(message);
      }
      throw new Error(
        message ?? "The terminal operation response was not confirmed.",
      );
    } catch (error) {
      if (error instanceof TerminalDefiniteRefusal) throw error;
      throw new Error(
        `Terminal operation outcome is unknown. ${error instanceof Error ? error.message : ""}`,
      );
    }
  }

  private persist(retiring?: TrackedOperation): void {
    this.tracking.write(
      STORAGE_KEY,
      [...this.operations.values()].flatMap((record) =>
        record !== retiring && record.operation ? [record.operation] : [],
      ),
    );
  }
  private publish(): void {
    const rows: TerminalRecoveryRow[] =
      this.recoveryState === "retired"
        ? [
            {
              key: RETIRED_STORAGE_KEY,
              label: "Terminal operations from a previous version",
              busy: false,
              outcome: "unknown",
              canRetry: false,
            },
          ]
        : [];
    for (const [key, { operation, outcome, task }] of this.operations) {
      if (!operation || !outcome) continue;
      rows.push({
        key,
        label: operationLabel(operation.intent),
        busy: Boolean(task),
        outcome,
        canRetry: true,
      });
    }
    this.state = rows;
    for (const listener of this.listeners) listener();
  }
}

class TerminalDefiniteRefusal extends Error {}
export const terminalOperations = new TerminalOperationController();
