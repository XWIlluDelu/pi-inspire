import { randomUUID } from "node:crypto";
import type {
  HostRestartOperation,
  HostRestartRequest,
  HostRestartStatus,
} from "../shared/host-restart.js";
import { requestError } from "./request-error.js";
import type { RuntimeLike } from "./runtime.js";

export interface HostRestartBackend {
  inspect(): Promise<{ host: boolean; all: boolean }>;
  prepare(): Promise<void>;
  request(
    all: boolean,
    commit: () => boolean,
  ): Promise<{ code: number; issued?: boolean }>;
}

const UNAVAILABLE =
  "Page restart requires the Inspire launcher or this Host's installed Linux systemd services.";
const ALL_UNAVAILABLE =
  "Restart all requires this Host's installed Linux systemd services.";

/** One process-scoped operation, shared by all observers. Only preparation and
 * proven non-issuance can reopen admission; HTTP observation is never authority. */
export class HostRestartController {
  private readonly hostId = randomUUID();
  private readonly receipts = new Map<string, HostRestartOperation>();
  private operation: HostRestartOperation | null = null;
  private availability: ReturnType<HostRestartBackend["inspect"]> | null = null;

  constructor(
    private readonly runtime: RuntimeLike,
    private readonly backend: HostRestartBackend,
  ) {}

  async status(): Promise<HostRestartStatus> {
    // Timed-out HTTP observers cannot accumulate unbounded systemctl reads.
    this.availability ??= this.backend
      .inspect()
      .catch(() => ({ host: false, all: false }))
      .finally(() => {
        this.availability = null;
      });
    const available = await this.availability;
    return {
      hostId: this.hostId,
      available: available.host,
      allAvailable: available.all,
      ...(!available.host ? { reason: UNAVAILABLE } : {}),
      ...(!available.all ? { allReason: ALL_UNAVAILABLE } : {}),
      operation: this.operation ? { ...this.operation } : null,
    };
  }

  start(request: HostRestartRequest): HostRestartOperation {
    if (request.hostId !== this.hostId)
      throw requestError("Host changed. Review restart again.", 409);
    const previous = this.receipts.get(request.operationId);
    if (previous) {
      if (
        previous.scope !== request.scope ||
        Boolean(previous.interruptWork) !== Boolean(request.interruptWork)
      )
        throw requestError("Restart operation does not match.", 409);
      return { ...previous };
    }
    if (this.operation && this.operation.phase !== "rejected")
      throw requestError(
        "A restart is already pending. Check its status.",
        409,
      );
    // Never forget an identity and accidentally admit it again on this Host.
    if (this.receipts.size >= 32)
      throw requestError(
        "Restart attempt limit reached. Use the Host CLI.",
        429,
      );
    const operation: HostRestartOperation = {
      id: request.operationId,
      scope: request.scope,
      ...(request.interruptWork ? { interruptWork: true as const } : {}),
      phase: "preparing",
    };
    this.receipts.set(operation.id, operation);
    this.operation = operation;
    void this.execute(operation);
    return { ...operation };
  }

  private async execute(operation: HostRestartOperation): Promise<void> {
    let leaseId: string | undefined;
    let mayHaveIssued = false;
    try {
      const available = await this.backend.inspect();
      if (!available[operation.scope])
        throw new Error(
          operation.scope === "all" ? ALL_UNAVAILABLE : UNAVAILABLE,
        );
      await this.backend.prepare();
      // Preparation can be slow. Acquire the authoritative admission fence
      // afterwards, not from an earlier observation of active work.
      const reservation = this.runtime.reserveMaintenanceRestart?.(
        operation.interruptWork === true,
      );
      if (reservation?.kind === "busy") {
        operation.busyReason = reservation.reason;
        throw new Error(
          reservation.reason === "restart-pending"
            ? "Another restart is already pending."
            : "Finish Pi work and pending operations before restarting, or choose Stop work and restart.",
        );
      }
      if (!reservation || reservation.kind !== "ready")
        throw new Error("Restart admission is unavailable.");
      leaseId = reservation.leaseId;
      const result = await this.backend.request(
        operation.scope === "all",
        () => {
          const committed = this.runtime.commitMaintenanceRestart?.(leaseId!);
          if (committed?.kind !== "committed") return false;
          mayHaveIssued = true;
          // Publish domain state before submission can disconnect this observer.
          operation.phase = "submitted";
          return true;
        },
      );
      if (result.issued === false) mayHaveIssued = false;
      if (result.code !== 0 || result.issued === false)
        throw new Error(
          mayHaveIssued
            ? "Restart outcome is unknown. Check the Host launcher or service."
            : "Restart was not issued. Check the Host launcher or service configuration.",
        );
    } catch (error) {
      if (!mayHaveIssued && leaseId) {
        try {
          const released = this.runtime.releaseMaintenanceRestart?.(leaseId);
          if (released?.kind !== "released") mayHaveIssued = true;
        } catch {
          mayHaveIssued = true;
        }
      }
      operation.phase = mayHaveIssued ? "unknown" : "rejected";
      operation.error = mayHaveIssued
        ? "Restart outcome is unknown. Check the Host launcher or service."
        : error instanceof Error
          ? error.message
          : "Restart preparation failed.";
    }
  }
}
