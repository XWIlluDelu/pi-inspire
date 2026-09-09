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
          Object.keys(value).sort().join() !== "hostId,operationId,scope" ||
          typeof value.hostId !== "string" ||
          !UUID.test(value.hostId) ||
          typeof value.operationId !== "string" ||
          !UUID.test(value.operationId) ||
          !["host", "all"].includes(value.scope)
        )
          throw new Error();
        this.patch({ pending: value });
      }
      this.loaded = true;
    } catch {
      this.patch({
        blocked: true,
        error:
          "Restart storage is unavailable or invalid. Controls are blocked.",
      });
      throw new Error("Restart storage unavailable");
    }
  }
  private persist(pending: HostRestartRequest | null): void {
    try {
      if (pending) this.storage().setItem(KEY, JSON.stringify(pending));
      else this.storage().removeItem(KEY);
    } catch {
      this.patch({
        blocked: true,
        error: "Restart storage is unavailable. Controls are blocked.",
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
    try {
      this.restore();
      const status = await this.api.hostRestartStatus();
      const pending = this.state.pending;
      if (pending && pending.hostId !== status.hostId) {
        this.persist(null);
        this.patch({ pending: null, notice: "Host reconnected." });
      } else if (
        pending &&
        status.operation?.id === pending.operationId &&
        status.operation.phase === "rejected"
      ) {
        this.persist(null);
        this.patch({ pending: null });
      }
      this.patch({ status, error: null });
    } catch {
      if (!this.state.blocked)
        this.patch({
          error:
            "Host status unavailable. Recheck without sending another restart.",
        });
    }
  }
  start = async (scope: HostRestartScope, hostId: string): Promise<void> => {
    if (this.state.sending || this.state.blocked || this.state.pending) return;
    try {
      this.restore();
      if (
        this.state.pending ||
        !this.state.status?.available ||
        this.state.status.hostId !== hostId
      )
        return;
      const pending = { hostId, operationId: crypto.randomUUID(), scope };
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
      this.patch({ error: "Restart request not confirmed. Check its status." });
    } finally {
      this.patch({ sending: false });
      await this.refresh();
    }
  };
}
export const hostRestartClient = new HostRestartClient();
