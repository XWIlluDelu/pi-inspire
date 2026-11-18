import {
  type HostRestartRequest,
  type HostRestartScope,
  type HostRestartStatus,
  hostRestartRequestSchema,
  matchesRestartIntent,
} from "../../shared/host-restart";
import { createApi } from "../api";
import { ReceiptRead } from "../operation-observer";
import { receiptStorage } from "../receipt-storage";

const KEY = "inspire:host-restart:v1";

interface State {
  status: HostRestartStatus | null;
  pending: HostRestartRequest | null;
  sending: boolean;
  blocked: boolean;
  error: string | null;
  notice: string | null;
}

/** Reconnect and retry preserve the original restart and its interruption grant. */
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
  private checked?: string;
  private readonly listeners = new Set<() => void>();
  private readonly observation = new ReceiptRead<"status", void>();
  private readonly tracking: ReturnType<
    typeof receiptStorage<HostRestartRequest | null>
  >;
  private receiptRevision = 0;
  constructor(
    private readonly api: Pick<
      ReturnType<typeof createApi>,
      "hostRestartStatus" | "restartHost"
    > = createApi(),
    storage?: () => Storage,
  ) {
    this.tracking = receiptStorage(
      512,
      hostRestartRequestSchema.parse,
      null,
      storage,
    );
  }
  snapshot = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private patch(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private restore(): boolean {
    if (!this.loaded) {
      const loaded = this.tracking.read(KEY);
      if (!loaded.issue) {
        this.track(loaded.value);
        return true;
      }
      if (loaded.issue === "format") {
        try {
          this.persist(null);
        } catch {
          return false;
        }
      } else
        this.patch({
          blocked: true,
          error: "Restart is unavailable in this tab.",
        });
    }
    return this.loaded;
  }
  private track(
    pending: HostRestartRequest | null,
    patch?: Partial<State>,
  ): void {
    this.loaded = true;
    this.patch({
      pending,
      blocked: false,
      error: null,
      ...patch,
    });
  }
  private persist(
    pending: HostRestartRequest | null,
    patch?: Partial<State>,
  ): void {
    try {
      this.tracking.write(KEY, pending);
      this.track(pending, patch);
    } catch {
      this.loaded = false;
      this.patch({
        blocked: true,
        error: "Restart is unavailable in this tab.",
      });
      throw new Error("Restart storage unavailable");
    }
  }
  refresh = (pendingOnly = false): Promise<void> =>
    this.observation.observe("status", () => this.observe(pendingOnly));
  private async observe(pendingOnly: boolean): Promise<void> {
    const receiptRevision = this.receiptRevision;
    const restored = this.restore();
    if (pendingOnly && !this.state.pending) return;
    try {
      const status = await this.api.hostRestartStatus();
      // A pre-POST read of the same Host can still describe the last attempt.
      if (
        receiptRevision !== this.receiptRevision &&
        status.hostId === this.state.status?.hostId
      )
        return;
      this.patch({ status, ...(restored ? { error: null } : {}) });
      if (!restored) return;
      const pending = this.state.pending;
      if (pending && pending.hostId !== status.hostId) {
        this.persist(null, { notice: "Host reconnected." });
      } else if (pending && matchesRestartIntent(status.operation, pending)) {
        this.checked = pending.operationId;
        if (status.operation?.phase === "rejected") this.persist(null);
      } else if (
        pending &&
        !this.state.sending &&
        this.checked !== pending.operationId &&
        (!status.operation || status.operation.phase === "rejected")
      ) {
        this.checked = pending.operationId;
        void this.retry();
      }
    } catch {
      if (!this.state.blocked && receiptRevision === this.receiptRevision)
        this.patch({ error: "Couldn’t reach Inspire." });
    }
  }
  start = async (
    scope: HostRestartScope,
    hostId: string,
    interruptWork = false,
    skipAttachedStop = false,
  ): Promise<void> => {
    if (this.state.sending || this.state.blocked || this.state.pending) return;
    try {
      if (
        !this.restore() ||
        this.state.pending ||
        !this.state.status ||
        (this.state.status.operation &&
          this.state.status.operation.phase !== "rejected") ||
        (scope === "all-pi" && !interruptWork) ||
        !(scope === "all-pi"
          ? this.state.status.allPiAvailable
          : this.state.status.available) ||
        this.state.status.hostId !== hostId
      )
        return;
      const pending: HostRestartRequest = {
        hostId,
        operationId: crypto.randomUUID(),
        scope,
        ...(interruptWork ? { interruptWork: true } : {}),
        ...(skipAttachedStop ? { skipAttachedStop: true } : {}),
      };
      this.persist(pending, { sending: true, notice: null });
      await this.send(pending);
    } catch {
      /* Storage errors are already visible and never dispatch. */
    }
  };
  retry = async (): Promise<void> => {
    const pending = this.state.pending;
    if (
      !pending ||
      this.state.sending ||
      this.state.blocked ||
      this.state.status?.hostId !== pending.hostId
    )
      return;
    this.patch({ sending: true, error: null });
    await this.send(pending);
  };

  private async send(pending: HostRestartRequest): Promise<void> {
    const previousOperationId = this.state.status?.operation?.id;
    try {
      const receipt = await this.api.restartHost(pending);
      const status = this.state.status;
      if (
        this.state.pending !== pending ||
        status?.hostId !== pending.hostId ||
        !matchesRestartIntent(receipt, pending)
      )
        return;

      this.checked = pending.operationId;
      const operation = status.operation;
      // A GET can already have seen a later phase, or another restart after
      // this one was rejected. Keep that observation instead of regressing it.
      if (
        !operation ||
        (operation.id === receipt.id &&
          (operation.phase === "preparing" ||
            (operation.phase === "submitted" &&
              receipt.phase !== "preparing"))) ||
        (operation.id === previousOperationId && operation.phase === "rejected")
      ) {
        this.receiptRevision += 1;
        this.patch({ status: { ...status, operation: receipt } });
      }
      if (receipt.phase === "rejected") {
        this.persist(null, {
          notice: receipt.error ?? "Restart was not issued.",
        });
      }
    } catch {
      if (!this.state.blocked && this.state.pending === pending)
        this.patch({
          error: "Couldn’t confirm the restart.",
        });
    } finally {
      this.patch({ sending: false });
      // Any read already in flight may predate this receipt. Observe again
      // after it settles so the browser can see the next authoritative phase.
      await this.observation.task;
      await this.refresh();
    }
  }
}
export const hostRestartClient = new HostRestartClient();
