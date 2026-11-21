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
  error: string | null;
  notice: string | null;
}

/** Reconnect and retry preserve the original restart and its interruption grant. */
export class HostRestartClient {
  private state: State = {
    status: null,
    pending: null,
    sending: false,
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
  private restore(): void {
    if (this.loaded) return;
    this.loaded = true;
    const loaded = this.tracking.read(KEY);
    if (!loaded.issue) {
      this.patch({ pending: loaded.value, error: null });
      return;
    }
    if (loaded.issue === "format") this.persist(null);
  }
  private persist(
    pending: HostRestartRequest | null,
    patch?: Partial<State>,
  ): void {
    try {
      this.tracking.write(KEY, pending);
    } catch {
      // Storage is optional (e.g. private tabs); keep restart tracking in memory.
    }
    this.loaded = true;
    this.patch({ pending, error: null, ...patch });
  }
  refresh = (pendingOnly = false): Promise<void> =>
    this.observation.observe("status", () => this.observe(pendingOnly));
  private async observe(pendingOnly: boolean): Promise<void> {
    const receiptRevision = this.receiptRevision;
    this.restore();
    if (pendingOnly && !this.state.pending) return;
    try {
      const status = await this.api.hostRestartStatus();
      // A pre-POST read of the same Host can still describe the last attempt.
      if (
        receiptRevision !== this.receiptRevision &&
        status.hostId === this.state.status?.hostId
      )
        return;
      this.patch({ status, error: null });
      const pending = this.state.pending;
      if (pending && pending.hostId !== status.hostId) {
        this.persist(null, { notice: "Host reconnected." });
      } else if (pending && matchesRestartIntent(status.operation, pending)) {
        this.checked = pending.operationId;
        if (
          status.operation?.phase === "rejected" ||
          status.operation?.phase === "unknown"
        )
          this.persist(null);
      } else if (
        pending &&
        !this.state.sending &&
        this.checked !== pending.operationId &&
        (!status.operation ||
          status.operation.phase === "rejected" ||
          status.operation.phase === "unknown")
      ) {
        this.checked = pending.operationId;
        void this.retry();
      }
    } catch {
      if (receiptRevision === this.receiptRevision)
        this.patch({ error: "Couldn’t reach Inspire." });
    }
  }
  start = async (
    scope: HostRestartScope,
    hostId: string,
    interruptWork = false,
    skipAttachedStop = false,
  ): Promise<void> => {
    if (this.state.sending || this.state.pending) return;
    this.restore();
    if (
      this.state.pending ||
      !this.state.status ||
      (this.state.status.operation &&
        this.state.status.operation.phase !== "rejected" &&
        this.state.status.operation.phase !== "unknown") ||
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
  };
  retry = async (): Promise<void> => {
    const pending = this.state.pending;
    if (
      !pending ||
      this.state.sending ||
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
      if (
        !operation ||
        (operation.id === receipt.id &&
          (operation.phase === "preparing" ||
            (operation.phase === "submitted" &&
              receipt.phase !== "preparing"))) ||
        (operation.id === previousOperationId &&
          (operation.phase === "rejected" || operation.phase === "unknown"))
      ) {
        this.receiptRevision += 1;
        this.patch({ status: { ...status, operation: receipt } });
      }
      if (receipt.phase === "rejected" || receipt.phase === "unknown") {
        this.persist(null, {
          notice: receipt.error ?? "Restart did not finish.",
        });
      }
    } catch {
      if (this.state.pending === pending)
        this.patch({
          error: "Restart did not finish. Try again.",
        });
    } finally {
      this.patch({ sending: false });
      await this.observation.task;
      await this.refresh();
    }
  }
}
export const hostRestartClient = new HostRestartClient();
