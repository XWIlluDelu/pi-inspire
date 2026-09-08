import type { TerminalOperationIdentity } from "../../shared/terminal-contracts";

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
interface PendingOperation {
  key: string;
  path: string;
  method: string;
  body?: string;
  identity: TerminalOperationIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (
    !knownMutation ||
    (body !== undefined &&
      (body.length > MAX_BODY_CHARS ||
        canonicalBody(JSON.parse(body)) !== body))
  )
    throw new Error("Terminal operation is invalid; controls are blocked.");
  return JSON.stringify([path, method, body ?? null]);
}

function restoredOperation(value: unknown): PendingOperation {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["key", "path", "method", "body", "identity"].includes(key),
    ) ||
    typeof value.key !== "string" ||
    value.key.length > MAX_KEY_CHARS ||
    typeof value.path !== "string" ||
    value.path.length > 128 ||
    typeof value.method !== "string" ||
    (value.body !== undefined && typeof value.body !== "string") ||
    !isRecord(value.identity) ||
    Object.keys(value.identity).some((key) => !["id", "epoch"].includes(key)) ||
    typeof value.identity.id !== "string" ||
    !IDENTITY_PART.test(value.identity.id) ||
    typeof value.identity.epoch !== "string" ||
    !IDENTITY_PART.test(value.identity.epoch) ||
    value.key !== operationKey(value.path, value.method, value.body)
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

interface TerminalOperationState {
  key: string;
  path: string;
  label: string;
  busy: boolean;
  uncertain: boolean;
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
 * writes survive pane generations and page reload; only a daemon receipt can
 * release an identity. No timeout or local abort claims cancellation. */
export class TerminalOperationController {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly uncertain = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private state: TerminalOperationState[] = [];
  private loaded = false;

  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private readonly storage: () => Storage = () => sessionStorage,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): TerminalOperationState[] => this.state;

  restore(): void {
    if (this.loaded) return;
    // Storage failure must not silently discard uncertain identities.
    const raw = this.storage().getItem(STORAGE_KEY);
    const restored = new Map<string, PendingOperation>();
    const identities = new Set<string>();
    try {
      if (raw !== null && raw.length > MAX_STORAGE_CHARS)
        throw new Error("Stored terminal operations exceed their limit");
      const entries: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > MAX_PENDING)
        throw new Error("Invalid stored terminal operations");
      for (const value of entries) {
        const entry = restoredOperation(value);
        const identity = `${entry.identity.epoch}:${entry.identity.id}`;
        if (restored.has(entry.key) || identities.has(identity))
          throw new Error("Duplicate stored terminal operation");
        restored.set(entry.key, entry);
        identities.add(identity);
      }
    } catch {
      throw new Error(
        "Terminal operation storage is invalid; controls are blocked.",
      );
    }
    // Validate the whole set before publishing any recoverable identity. A bad
    // later entry must not allow an earlier entry (or a new intent) to dispatch.
    for (const [key, entry] of restored) {
      this.pending.set(key, entry);
      this.uncertain.add(key);
    }
    this.loaded = true;
    this.publish();
  }

  run<T>(
    token: string | null,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    let serialized: string | undefined;
    let key: string;
    try {
      this.restore();
      serialized = canonicalBody(body);
      key = operationKey(path, method, serialized);
    } catch (error) {
      return Promise.reject(error);
    }
    const running = this.running.get(key);
    if (running) return running as Promise<T>;
    const task = this.deliver<T>(token, key, path, method, serialized).finally(
      () => {
        this.running.delete(key);
        if (this.pending.has(key)) this.uncertain.add(key);
        else this.uncertain.delete(key);
        this.publish();
      },
    );
    this.running.set(key, task);
    this.publish();
    return task;
  }

  retry(token: string | null, key: string): Promise<unknown> {
    try {
      this.restore();
    } catch (error) {
      return Promise.reject(error);
    }
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();
    return this.run(
      token,
      entry.path,
      entry.method,
      entry.body === undefined ? undefined : JSON.parse(entry.body),
    );
  }

  private async deliver<T>(
    token: string | null,
    key: string,
    path: string,
    method: string,
    body?: string,
  ): Promise<T> {
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= MAX_PENDING)
        throw new Error(
          "Too many unresolved terminal operations. Resolve existing operations first.",
        );
      const response = await this.transport("/api/terminal-operations", {
        credentials: "same-origin",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(
          "Terminal operation receipts are unavailable. No terminal control was sent.",
        );
      const { epoch } = (await response.json()) as { epoch?: unknown };
      if (typeof epoch !== "string" || !IDENTITY_PART.test(epoch))
        throw new Error(
          "Terminal operation epoch is invalid. No terminal control was sent.",
        );
      // Other distinct intents may have completed their epoch lookup meanwhile.
      if (this.pending.size >= MAX_PENDING)
        throw new Error("Too many unresolved terminal operations.");
      entry = {
        key,
        path,
        method,
        body,
        identity: { id: crypto.randomUUID(), epoch },
      };
      this.pending.set(key, entry);
      this.persist(); // Must succeed before dispatch.
      this.publish();
    }
    this.persist(); // A previous storage failure cannot make a retry untracked.
    let response: Response;
    try {
      response = await this.transport(path, {
        method,
        body,
        credentials: "same-origin",
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-Terminal-Operation": JSON.stringify(entry.identity),
        },
        signal: AbortSignal.timeout(20_000),
      });
      const outcome = response.headers.get("X-Terminal-Outcome");
      const matched =
        response.headers.get("X-Terminal-Operation") === entry.identity.id;
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
        } catch (error) {
          // If retiring the receipt cannot be persisted, keep the same identity
          // in memory too. A displayed recovery error must never become a new
          // delivery merely because storage failed after the daemon committed.
          this.pending.set(key, entry);
          throw error;
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
      JSON.stringify([...this.pending.values()]),
    );
  }
  private publish(): void {
    this.state = [...this.pending.values()].map((entry) => ({
      key: entry.key,
      path: entry.path,
      label: operationLabel(entry),
      busy: this.running.has(entry.key),
      uncertain: this.uncertain.has(entry.key),
    }));
    for (const listener of this.listeners) listener();
  }
}

class TerminalDefiniteRefusal extends Error {}
export const terminalOperations = new TerminalOperationController();
