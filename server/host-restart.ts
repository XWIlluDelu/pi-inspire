import { randomUUID } from "node:crypto";
import {
  canStartHostRestart,
  type HostRestartOperation,
  type HostRestartRequest,
  type HostRestartScope,
  type HostRestartStatus,
  matchesRestartIntent,
} from "../shared/host-restart.js";
import { requestError } from "./request-error.js";
import { type RestartSubmission, settleRestart } from "./restart-submission.mjs";
import type { RuntimeController } from "./runtime.js";

export interface HostRestartBackend {
  inspect(): Promise<{
    host: boolean;
    allPi?: boolean;
    includeHerdr?: boolean;
  }>;
  prepare(): Promise<void>;
  request(
    scope: HostRestartScope,
    commit: () => boolean | Promise<boolean>,
  ): Promise<RestartSubmission>;
}

const UNAVAILABLE =
  "Page restart requires the Inspire launcher or installed Linux systemd service.";
const ALL_PI_UNAVAILABLE =
  "Restart all requires the installed Linux service and Pi process control.";
const WORK_BUSY =
  "Finish active Pi work before restarting, or stop work and restart.";

/** One process-scoped operation, shared by all observers. Only preparation and
 * proven non-issuance can reopen admission; HTTP observation is never authority. */
export class HostRestartController {
  private readonly hostId = randomUUID();
  private readonly receipts: HostRestartOperation[] = [];
  private get operation() {
    return this.receipts.at(-1);
  }
  private availability: ReturnType<HostRestartBackend["inspect"]> | null = null;

  constructor(
    private readonly runtime: Pick<
      RuntimeController,
      | "reserveMaintenanceRestart"
      | "commitMaintenanceRestart"
      | "releaseMaintenanceRestart"
      | "checkAttachedRestartWork"
      | "stopAttachedPiWork"
    >,
    private readonly backend: HostRestartBackend,
  ) {}

  async status(): Promise<HostRestartStatus> {
    // Timed-out HTTP observers cannot accumulate unbounded systemctl reads.
    this.availability ??= this.backend
      .inspect()
      .catch(() => ({ host: false }))
      .finally(() => {
        this.availability = null;
      });
    const available = await this.availability;
    return {
      hostId: this.hostId,
      available: available.host,
      allPiAvailable: available.allPi === true,
      allPiIncludesHerdr: available.includeHerdr === true,
      ...(!available.allPi ? { allPiReason: ALL_PI_UNAVAILABLE } : {}),
      ...(!available.host ? { reason: UNAVAILABLE } : {}),
      operation: this.operation ? { ...this.operation } : null,
    };
  }

  start(request: HostRestartRequest): HostRestartOperation {
    if (request.hostId !== this.hostId)
      throw requestError("Host changed. Review restart again.", 409);
    if (request.scope === "all-pi" && request.interruptWork !== true)
      throw requestError(
        "Confirm closing all Pi sessions before restarting.",
        400,
      );
    const previous = this.receipts.find(({ id }) => id === request.operationId);
    if (previous) {
      if (!matchesRestartIntent(previous, request))
        throw requestError("Restart operation does not match.", 409);
      return { ...previous };
    }
    if (!canStartHostRestart(this.operation))
      throw requestError(
        this.operation?.error ?? "A restart is already in progress.",
        409,
      );
    if (this.receipts.length >= 32) this.receipts.shift();
    const operation: HostRestartOperation = {
      id: request.operationId,
      scope: request.scope,
      ...(request.interruptWork ? { interruptWork: true as const } : {}),
      ...(request.skipAttachedStop ? { skipAttachedStop: true as const } : {}),
      phase: "preparing",
    };
    this.receipts.push(operation);
    void this.execute(operation);
    return { ...operation };
  }

  private async execute(operation: HostRestartOperation): Promise<void> {
    let leaseId: string | undefined;
    let result: RestartSubmission;
    try {
      const available = await this.backend.inspect();
      const global = operation.scope === "all-pi";
      if (!(global ? available.allPi : available.host))
        throw new Error(global ? ALL_PI_UNAVAILABLE : UNAVAILABLE);
      await this.backend.prepare();
      // Preparation can be slow. Acquire the authoritative admission fence
      // afterwards, not from an earlier observation of active work.
      const reservation = this.runtime.reserveMaintenanceRestart(
        operation.interruptWork === true,
        true,
      );
      if (reservation.kind === "busy") {
        operation.busyReason = reservation.reason;
        throw new Error(
          reservation.reason === "restart-pending"
            ? "Another restart is already pending."
            : WORK_BUSY,
        );
      }
      leaseId = reservation.leaseId;
      if (
        operation.scope !== "all-pi" &&
        operation.interruptWork &&
        !operation.skipAttachedStop
      ) {
        try {
          await this.runtime.stopAttachedPiWork();
        } catch (error) {
          operation.stopUnconfirmed = true;
          throw error;
        }
      }
      result = await this.backend.request(operation.scope, async () => {
        if (!operation.interruptWork) {
          const busy = await this.runtime.checkAttachedRestartWork();
          if (busy) {
            operation.busyReason = busy;
            return false;
          }
        }
        const committed = this.runtime.commitMaintenanceRestart(
          reservation.leaseId,
        );
        if (committed.kind !== "committed") {
          if (
            committed.kind === "skipped" &&
            (committed.reason === "active-work" ||
              committed.reason === "in-flight-operation")
          )
            operation.busyReason = committed.reason;
          return false;
        }
        // Publish domain state before submission can disconnect this observer.
        operation.phase = "submitted";
        return true;
      });
    } catch (error) {
      result = operation.phase === "submitted"
        ? { kind: "unconfirmed" }
        : {
            kind: "not-issued",
            reason: "pre-restart-failed",
            error: error instanceof Error ? error : new Error("Restart preparation failed."),
          };
    }
    const lease = leaseId;
    if (lease)
      result = await settleRestart(result, () =>
        this.runtime.releaseMaintenanceRestart(lease).kind === "released",
      );
    if (result.kind === "issued") return;
    if (result.kind === "unconfirmed") {
      operation.phase = "unknown";
      operation.error =
        "The restart may still be pending. Check the Host launcher or service.";
      return;
    }
    operation.phase = "rejected";
    operation.error = result.error instanceof Error
      ? result.error.message
      : operation.busyReason
        ? WORK_BUSY
        : "Restart was not issued. Check the Host launcher or service configuration.";
  }
}
