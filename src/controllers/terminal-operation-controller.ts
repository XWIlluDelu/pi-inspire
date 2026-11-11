import { isJsonRecord } from "../../shared/json-record";
import type { TerminalOperationIdentity } from "../../shared/terminal-contracts";
import { authenticatedFetch } from "../browser-auth";

const STORAGE_KEY = "inspire:terminal-operations:v1";
const MAX_PENDING = 128;
// Covers even fully JSON-escaped maximum cwd/profile/order request fields.
const MAX_BODY_CHARS = 32 * 1024;
const MAX_KEY_CHARS = 2 * MAX_BODY_CHARS + 256;
const MAX_STORAGE_CHARS =
  MAX_PENDING * (2 * MAX_KEY_CHARS + 2 * MAX_BODY_CHARS + 1024);
const IDENTITY_PART = /^[A-Za-z0-9_-]{1,80}$/u;

function canonicalBody(body: unknown): string | undefined {
  return JSON.stringify(body, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}
interface TerminalIntent {
  key: string;
  path: string;
  method: string;
  body?: string;
}

interface PendingOperation extends TerminalIntent {
  identity: TerminalOperationIdentity;
}

type RecoveryOutcome = "unknown" | "completed" | "rejected";

interface TrackedOperation {
  intent: PendingOperation;
  outcome?: RecoveryOutcome;
}

function operationKey(path: string, method: string, body?: string): string {
  const knownMutation =
    (method === "POST" &&
      (path === "/api/terminals" ||
        path === "/api/terminals/reorder" ||
        /^\/api\/terminals\/[A-Za-z0-9_-]{1,80}\/restart$/u.test(path))) ||
    (method === "PATCH" &&
      (path === "/api/terminal-settings" ||
        /^\/api\/terminals\/[A-Za-z0-9_-]{1,80}$/u.test(path))) ||
    (method === "DELETE" &&
      (path === "/api/terminal-history" ||
        /^\/api\/terminals\/[A-Za-z0-9_-]{1,80}(?:\?force=1)?$/u.test(path)));
  if (!knownMutation || (body !== undefined && body.length > MAX_BODY_CHARS))
    throw new Error("Terminal operation is invalid; controls are blocked.");
  return JSON.stringify([path, method, body ?? null]);
}

function restoredOperation(value: unknown): PendingOperation {
  if (
    !isJsonRecord(value) ||
    Object.keys(value).some(
      (key) => !["key", "path", "method", "body", "identity"].includes(key),
    ) ||
    typeof value.key !== "string" ||
    value.key.length > MAX_KEY_CHARS ||
    typeof value.path !== "string" ||
    value.path.length > 128 ||
    typeof value.method !== "string" ||
    (value.body !== undefined && typeof value.body !== "string") ||
    !isJsonRecord(value.identity) ||
    Object.keys(value.identity).some((key) => !["id", "epoch"].includes(key)) ||
    typeof value.identity.id !== "string" ||
    !IDENTITY_PART.test(value.identity.id) ||
    typeof value.identity.epoch !== "string" ||
    !IDENTITY_PART.test(value.identity.epoch) ||
    value.key !== operationKey(value.path, value.method, value.body) ||
    (value.body !== undefined &&
      canonicalBody(JSON.parse(value.body)) !== value.body)
  )
    throw new Error("Invalid stored terminal operation");
  return {
    key: value.key,
    path: value.path,
    method: value.method,
    body: value.body,
    identity: { id: value.identity.id, epoch: value.identity.epoch },
  };
}

interface TerminalRecoveryRow {
  key: string;
  label: string;
  busy: boolean;
  outcome: RecoveryOutcome;
}

function operationLabel(entry: PendingOperation): string {
  const action =
    entry.path === "/api/terminals"
      ? "Create terminal"
      : entry.path === "/api/terminals/reorder"
        ? "Reorder terminals"
        : entry.path === "/api/terminal-settings"
          ? "Terminal settings"
          : entry.path === "/api/terminal-history"
            ? "Clear terminal history"
            : entry.path.endsWith("/restart")
              ? "Restart terminal"
              : entry.method === "DELETE"
                ? "Close terminal"
                : "Rename terminal";
  const body = entry.body
    ? (JSON.parse(entry.body) as { cwd?: unknown } | null)
    : null;
  const target =
    typeof body?.cwd === "string"
      ? body.cwd
      : entry.path.startsWith("/api/terminals/") &&
          entry.path !== "/api/terminals/reorder"
        ? entry.path.split("/")[3]!.split("?")[0]
        : "";
  return target ? `${action} · ${target}` : action;
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
    const raw = this.storage().getItem(STORAGE_KEY);
    const restored = new Map<string, TrackedOperation>();
    const identities = new Set<string>();
    try {
      if (raw !== null && raw.length > MAX_STORAGE_CHARS)
        throw new Error("Stored terminal operations exceed their limit");
      const entries: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > MAX_PENDING)
        throw new Error("Invalid stored terminal operations");
      for (const value of entries) {
        const intent = restoredOperation(value);
        const identity = `${intent.identity.epoch}:${intent.identity.id}`;
        if (restored.has(intent.key) || identities.has(identity))
          throw new Error("Duplicate stored terminal operation");
        restored.set(intent.key, { intent, outcome: "unknown" });
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
    this.loaded = true;
    this.publish();
  }

  run<T>(
    token: string | null,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    let intent: TerminalIntent;
    try {
      this.restore();
      const serialized = canonicalBody(body);
      intent = {
        key: operationKey(path, method, serialized),
        path,
        method,
        body: serialized,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    return this.dispatch<T>(token, intent);
  }

  private dispatch<T>(
    token: string | null,
    intent: TerminalIntent,
  ): Promise<T> {
    const { key } = intent;
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
    const task = this.deliver<T>(token, intent).finally(() => {
      this.running.delete(key);
      const pending = this.pending.get(key);
      if (pending) pending.outcome ??= "unknown";
      this.publish();
    });
    this.running.set(key, task);
    this.publish();
    return task;
  }

  retry(token: string | null, key: string): Promise<unknown> {
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
    return this.dispatch(token, pending.intent);
  }

  /** Retire a recovery record; never dispatch or claim cancellation. */
  stopTracking(key: string): void {
    this.restore();
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

  private async deliver<T>(
    token: string | null,
    intent: TerminalIntent,
  ): Promise<T> {
    const { key, path, method, body } = intent;
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= MAX_PENDING)
        throw new Error(
          "Too many unresolved terminal operations. Resolve existing operations first.",
        );
      const response = await authenticatedFetch(
        "/api/terminal-operations",
        {
          credentials: "same-origin",
          headers,
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
      if (typeof epoch !== "string" || !IDENTITY_PART.test(epoch))
        throw new Error(
          "Terminal operation epoch is invalid. No terminal control was sent.",
        );
      // Other distinct intents may have completed their epoch lookup meanwhile.
      if (this.pending.size >= MAX_PENDING)
        throw new Error("Too many unresolved terminal operations.");
      pending = {
        intent: {
          ...intent,
          identity: { id: crypto.randomUUID(), epoch },
        },
      };
      this.pending.set(key, pending);
    }
    this.persist(); // A previous storage failure cannot make a retry untracked.
    const { identity } = pending.intent;
    let response: Response;
    try {
      response = await authenticatedFetch(
        path,
        {
          method,
          body,
          credentials: "same-origin",
          headers: {
            ...headers,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            "X-Terminal-Operation": JSON.stringify(identity),
          },
          signal: AbortSignal.timeout(20_000),
        },
        this.transport,
      );
      const outcome = response.headers.get("X-Terminal-Outcome");
      const matched =
        response.headers.get("X-Terminal-Operation") === identity.id;
      const result =
        response.status === 204
          ? undefined
          : ((await response.json()) as { error?: string });
      if (
        matched &&
        ((response.ok && outcome === "completed") || outcome === "rejected")
      ) {
        this.pending.delete(key);
        try {
          this.persist();
        } catch {
          // Local bookkeeping failure cannot undo the daemon's confirmed result.
          // Keep the identity for cleanup without reporting an unknown operation.
          pending.outcome = response.ok ? "completed" : "rejected";
          this.pending.set(key, pending);
        }
        if (response.ok) return result as T;
        throw new TerminalDefiniteRefusal(
          result?.error ?? "The terminal operation was refused.",
        );
      }
      throw new Error(
        result?.error ?? "The terminal operation response was not confirmed.",
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
      JSON.stringify([...this.pending.values()].map(({ intent }) => intent)),
    );
  }
  private publish(): void {
    const rows: TerminalRecoveryRow[] = [];
    for (const { intent, outcome } of this.pending.values()) {
      if (!outcome) continue;
      rows.push({
        key: intent.key,
        label: operationLabel(intent),
        busy: this.running.has(intent.key),
        outcome,
      });
    }
    this.state = rows;
    for (const listener of this.listeners) listener();
  }
}

class TerminalDefiniteRefusal extends Error {}
export const terminalOperations = new TerminalOperationController();
