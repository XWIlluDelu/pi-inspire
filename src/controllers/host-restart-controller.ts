import type {
  HostRestartRequest,
  HostRestartScope,
  HostRestartStatus,
} from "../../shared/host-restart";
import { createApi } from "../api";

const KEY = "inspire:host-restart:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
interface State {
  status: HostRestartStatus | null;
  pending: HostRestartRequest | null;
  sending: boolean;
  blocked: boolean;
  error: string | null;
  notice: string | null;
}

/** Delivery identity is persisted before dispatch. Recheck only reads; an
 * explicit retry sends the same identity, never a new restart after a timeout. */
export class HostRestartClient {
  private state: State = {
    status: null,
    pending: null,
    sending: false,
    blocked: false,
    error: null,
    notice: null,
  };
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private observation: Promise<void> | null = null;
  constructor(
    private readonly api: Pick<
      ReturnType<typeof createApi>,
      "hostRestartStatus" | "restartHost"
    > = createApi(),
    private readonly storage: () => Storage = () => sessionStorage,
  ) {}
  snapshot = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private patch(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private restore(): void {
    if (this.loaded) return;
    try {
      const raw = this.storage().getItem(KEY);
      if (raw !== null) {
        if (raw.length > 512) throw new Error();
        const value = JSON.parse(raw) as HostRestartRequest;
        if (
          !value ||
          typeof value !== "object" ||
          ![
            "hostId,operationId,scope",
            "hostId,interruptWork,operationId,scope",
          ].includes(Object.keys(value).sort().join()) ||
          typeof value.hostId !== "string" ||
          !UUID.test(value.hostId) ||
          typeof value.operationId !== "string" ||
          !UUID.test(value.operationId) ||
          !["host", "all"].includes(value.scope) ||
          ("interruptWork" in value && value.interruptWork !== true)
        )
          throw new Error();
        this.patch({ pending: value });
      } else {
        this.patch({ pending: null });
      }
      this.loaded = true;
      this.patch({ blocked: false, error: null });
    } catch {
      this.patch({
        blocked: true,
        error:
          "The browser's restart recovery record is unreadable. Restart requests are disabled; Host status remains available.",
      });
      throw new Error("Restart storage unavailable");
    }
  }
  private persist(pending: HostRestartRequest | null): void {
    try {
      if (pending) this.storage().setItem(KEY, JSON.stringify(pending));
      else this.storage().removeItem(KEY);
      this.patch({ blocked: false, error: null });
    } catch {
      this.loaded = false;
      this.patch({
        blocked: true,
        error:
          "The browser could not save its restart recovery record. Recheck status or clear the local record before trying another restart.",
      });
      throw new Error("Restart storage unavailable");
    }
  }
  refresh = (): Promise<void> => {
    if (this.observation) return this.observation;
    this.observation = this.observe().finally(() => {
      this.observation = null;
    });
    return this.observation;
  };
  private async observe(): Promise<void> {
    let restored = false;
    try {
      this.restore();
      restored = true;
    } catch {
      // Recovery bookkeeping cannot prevent a read of the actual Host state.
    }
    try {
      const status = await this.api.hostRestartStatus();
      this.patch({ status, ...(restored ? { error: null } : {}) });
      if (!restored) return;
      const pending = this.state.pending;
      if (pending && pending.hostId !== status.hostId) {
        this.persist(null);
        this.patch({ pending: null, notice: "Host reconnected." });
      } else if (
        pending &&
        status.operation?.id === pending.operationId &&
        status.operation.scope === pending.scope &&
        Boolean(status.operation.interruptWork) ===
          Boolean(pending.interruptWork) &&
        status.operation.phase === "rejected"
      ) {
        this.persist(null);
        this.patch({ pending: null });
      }
    } catch {
      if (!this.state.blocked)
        this.patch({
          error:
            "Host status unavailable. Recheck without sending another restart.",
        });
    }
  }
  /** Explicitly discard browser tracking, never cancel or resend a Host restart. */
  clearRecovery = async (): Promise<void> => {
    if (this.state.sending) return;
    try {
      this.persist(null);
      this.loaded = true;
      this.patch({
        pending: null,
        notice:
          "Local restart tracking cleared. This does not cancel a restart already sent.",
      });
      await this.refresh();
    } catch {
      // The storage error remains visible; do not discard an in-memory identity.
    }
  };
  start = async (
    scope: HostRestartScope,
    hostId: string,
    interruptWork = false,
  ): Promise<void> => {
    if (this.state.sending || this.state.blocked || this.state.pending) return;
    try {
      this.restore();
      if (
        this.state.pending ||
        !this.state.status ||
        !(scope === "all"
          ? this.state.status.allAvailable
          : this.state.status.available) ||
        this.state.status.hostId !== hostId
      )
        return;
      const pending: HostRestartRequest = {
        hostId,
        operationId: crypto.randomUUID(),
        scope,
        ...(interruptWork ? { interruptWork: true } : {}),
      };
      this.persist(pending);
      this.patch({ pending, notice: null });
      await this.retry();
    } catch {
      /* Storage errors are already visible and never dispatch. */
    }
  };
  retry = async (): Promise<void> => {
    const pending = this.state.pending;
    if (!pending || this.state.sending || this.state.blocked) return;
    this.patch({ sending: true, error: null });
    try {
      const receipt = await this.api.restartHost(pending);
      if (
        receipt.id === pending.operationId &&
        receipt.scope === pending.scope &&
        Boolean(receipt.interruptWork) === Boolean(pending.interruptWork) &&
        receipt.phase === "rejected" &&
        this.state.pending === pending
      ) {
        this.persist(null);
        this.patch({
          pending: null,
          notice: receipt.error ?? "Restart was not issued.",
        });
      }
    } catch {
      if (!this.state.blocked)
        this.patch({
          error: "Restart request not confirmed. Check its status.",
        });
    } finally {
      this.patch({ sending: false });
      await this.refresh();
    }
  };
}
export const hostRestartClient = new HostRestartClient();
