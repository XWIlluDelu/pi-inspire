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
import { ApiError, ApiTransportError, request } from "../http-request";
import { ReceiptRead } from "../operation-observer";
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
        {
          operation,
          outcome: "unknown",
          observation: new ReceiptRead<string, unknown>(),
        },
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
    const tracked = this.operations.get(key) ?? {
      observation: new ReceiptRead<string, unknown>(),
    };
    if (tracked.observation.task) return tracked.observation.task as Promise<T>;
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
    const task = tracked.observation.observe(
      key,
      () => Promise.resolve().then(() => this.deliver<T>(tracked, intent)),
      () => {
        if (!tracked.operation) this.operations.delete(key);
        this.publish();
      },
    );
    this.operations.set(key, tracked);
    this.publish();
    return task as Promise<T>;
  }

  async retry(key: string): Promise<unknown> {
    this.restore();
    const tracked = this.operations.get(key);
    if (tracked?.observation.task) return tracked.observation.task;
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
    if (tracked?.observation.pending)
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
      const { epoch } = await request<{ epoch?: unknown }>(
        TERMINAL_OPERATIONS_PATH,
        {},
        { timeoutMs: 10_000 },
        this.transport,
      ).catch((error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        const reason =
          error.message === `Request failed (${error.status})`
            ? "Terminal operation receipts are unavailable."
            : error.message.slice(0, 1000);
        throw new Error(`${reason} No terminal control was sent.`);
      });
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
    const identity = terminalReceiptIdentity(operation);
    const path = previous
      ? `${TERMINAL_OPERATIONS_PATH}?observe=1`
      : TERMINAL_OPERATIONS_PATH;
    const unknown = (detail: string) =>
      new Error(`Terminal operation outcome is unknown. ${detail}`);
    const receipt = await request<MatchedReceipt>(
      path,
      { method: "POST", body: JSON.stringify(operation) },
      { timeoutMs: 20_000, matchReceipt: identity },
      this.transport,
    ).catch((error: unknown) => {
      const message =
        error instanceof ApiTransportError && error.phase === "response"
          ? "The terminal operation response was not confirmed."
          : error instanceof Error
            ? error.message
            : "";
      throw unknown(message);
    });
    if (receipt.state !== "completed" && receipt.state !== "rejected")
      throw unknown(
        receipt.state === "unknown"
          ? receipt.error.message
          : "The terminal operation response was not confirmed.",
      );
    try {
      this.removeOperation(tracked);
    } catch {
      // Keep the confirmed terminal outcome available for local cleanup.
      tracked.outcome = receipt.state;
    }
    if (receipt.state === "rejected") throw new Error(receipt.error.message);
    return receipt.result as T;
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
    for (const [key, { operation, outcome, observation }] of this.operations) {
      if (!operation || !outcome) continue;
      rows.push({
        key,
        label: operationLabel(operation.intent),
        busy: observation.pending,
        outcome,
        canRetry: true,
      });
    }
    this.state = rows;
    for (const listener of this.listeners) listener();
  }
}

export const terminalOperations = new TerminalOperationController();
