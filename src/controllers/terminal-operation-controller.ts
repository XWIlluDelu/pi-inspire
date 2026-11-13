import { matchOperationReceipt } from "../../shared/host-operations";
import { isJsonRecord } from "../../shared/json-record";
import {
  TERMINAL_OPERATIONS_PATH,
  terminalIntentSchema,
  terminalOperationSchema,
  terminalReceiptIdentity,
  type TerminalIntent,
  type TerminalOperation,
  type TerminalOperationResults,
} from "../../shared/terminal-operations";
import { authenticatedFetch } from "../browser-auth";

const STORAGE_KEY = "inspire:terminal-operations:v2";
const RETIRED_STORAGE_KEY = "inspire:terminal-operations:v1";
const MAX_PENDING = 128;
// Allows maximum-length terminal names and fully JSON-escaped paths.
const MAX_STORAGE_CHARS = MAX_PENDING * 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type RecoveryOutcome = "unknown" | "completed" | "rejected";
interface TrackedOperation {
  operation: TerminalOperation;
  outcome?: RecoveryOutcome;
}

function intentKey(intent: TerminalIntent): string {
  return JSON.stringify(intent);
}

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
  private pending = new Map<string, TrackedOperation>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private state: TerminalRecoveryRow[] = [];
  private loaded = false;
  private retiredRecords = false;

  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private readonly storage: () => Storage = () => sessionStorage,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): TerminalRecoveryRow[] => this.state;

  restore(): void {
    if (this.loaded) return;
    // Storage failure must not silently discard uncertain identities.
    const storage = this.storage();
    const raw = storage.getItem(STORAGE_KEY);
    const retired = storage.getItem(RETIRED_STORAGE_KEY);
    const restored = new Map<string, TrackedOperation>();
    const identities = new Set<string>();
    try {
      if (raw !== null && raw.length > MAX_STORAGE_CHARS)
        throw new Error("Stored terminal operations exceed their limit");
      const entries: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > MAX_PENDING)
        throw new Error("Invalid stored terminal operations");
      for (const value of entries) {
        const operation = terminalOperationSchema.parse(value);
        const key = intentKey(operation.intent);
        const identity = `${operation.executor.epoch}:${operation.operationId}`;
        if (restored.has(key) || identities.has(identity))
          throw new Error("Duplicate stored terminal operation");
        restored.set(key, { operation, outcome: "unknown" });
        identities.add(identity);
      }
    } catch {
      throw new Error(
        "Terminal operation storage is invalid; controls are blocked.",
      );
    }
    // Validate the whole set before publishing any recoverable identity. A bad
    // later entry must not allow an earlier entry (or a new intent) to dispatch.
    this.pending = restored;
    this.retiredRecords = retired !== null && retired !== "[]";
    this.loaded = true;
    this.publish();
  }

  run<I extends TerminalIntent>(
    intent: I,
  ): Promise<TerminalOperationResults[I["command"]]> {
    try {
      this.restore();
      if (this.retiredRecords)
        throw new Error(
          "Check your terminals and stop tracking the previous version’s operations before sending new controls.",
        );
      const valid = terminalIntentSchema.parse(intent);
      return this.dispatch<TerminalOperationResults[I["command"]]>(valid);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private dispatch<T>(intent: TerminalIntent): Promise<T> {
    const key = intentKey(intent);
    const running = this.running.get(key);
    if (running) return running as Promise<T>;
    // A confirmed result makes another click a new intent, not a replay.
    // Retire its stored recovery record before admitting that new intent.
    const outcome = this.pending.get(key)?.outcome;
    if (outcome && outcome !== "unknown") {
      try {
        this.stopTracking(key);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const task = this.deliver<T>(key, intent).finally(() => {
      this.running.delete(key);
      const pending = this.pending.get(key);
      if (pending) pending.outcome ??= "unknown";
      this.publish();
    });
    this.running.set(key, task);
    this.publish();
    return task;
  }

  retry(key: string): Promise<unknown> {
    let pending: TrackedOperation | undefined;
    try {
      this.restore();
      pending = this.pending.get(key);
      if (pending?.outcome && pending.outcome !== "unknown") {
        this.stopTracking(key);
        return Promise.resolve();
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (!pending) return Promise.resolve();
    return this.dispatch(pending.operation.intent);
  }

  /** Retire a recovery record; never dispatch or claim cancellation. */
  stopTracking(key: string): void {
    this.restore();
    if (key === RETIRED_STORAGE_KEY && this.retiredRecords) {
      this.storage().removeItem(RETIRED_STORAGE_KEY);
      this.retiredRecords = false;
      this.publish();
      return;
    }
    if (this.running.has(key))
      throw new Error(
        "Wait for the current terminal operation check to finish.",
      );
    const pending = this.pending.get(key);
    if (!pending?.outcome) return;
    this.pending.delete(key);
    try {
      this.persist();
    } catch (error) {
      this.pending.set(key, pending);
      throw error;
    }
    this.publish();
  }

  private async deliver<T>(key: string, intent: TerminalIntent): Promise<T> {
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= MAX_PENDING)
        throw new Error(
          "Too many unresolved terminal operations. Resolve existing operations first.",
        );
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
      if (typeof epoch !== "string" || !UUID.test(epoch))
        throw new Error(
          "Terminal operation epoch is invalid. No terminal control was sent.",
        );
      // Other distinct intents may have completed their epoch lookup meanwhile.
      if (this.pending.size >= MAX_PENDING)
        throw new Error("Too many unresolved terminal operations.");
      pending = {
        operation: {
          executor: { kind: "terminal", epoch },
          operationId: crypto.randomUUID(),
          intent,
        },
      };
      this.pending.set(key, pending);
    }
    this.persist(); // A previous storage failure cannot make a retry untracked.
    const { operation } = pending;
    try {
      const response = await authenticatedFetch(
        TERMINAL_OPERATIONS_PATH,
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
      const error = isJsonRecord(receipt?.error) ? receipt.error : null;
      const message =
        typeof error?.message === "string" ? error.message : undefined;
      const completed =
        receipt &&
        response.ok &&
        receipt.state === "completed" &&
        "result" in receipt;
      const rejected =
        receipt &&
        !response.ok &&
        receipt.state === "rejected" &&
        error?.status === response.status &&
        !!message;
      if (completed || rejected) {
        this.pending.delete(key);
        try {
          this.persist();
        } catch {
          // Local bookkeeping failure cannot undo the daemon's confirmed result.
          // Keep the identity for cleanup without reporting an unknown operation.
          pending.outcome = completed ? "completed" : "rejected";
          this.pending.set(key, pending);
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

  private persist(): void {
    this.storage().setItem(
      STORAGE_KEY,
      JSON.stringify(
        [...this.pending.values()].map(({ operation }) => operation),
      ),
    );
  }
  private publish(): void {
    const rows: TerminalRecoveryRow[] = this.retiredRecords
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
    for (const [key, { operation, outcome }] of this.pending) {
      if (!outcome) continue;
      rows.push({
        key,
        label: operationLabel(operation.intent),
        busy: this.running.has(key),
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
