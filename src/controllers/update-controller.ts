import {
  type AvailableUpdate,
  type HostUpdateStatus,
  type PiUpdateCheckResponse,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import type { Api } from "../api";
import type { WireEvent } from "../events";

interface UpdateControllerState {
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  availableUpdate: AvailableUpdate | null;
  availableUpdateIdentity: string | null;
  updateSnoozedUntil: number | null;
}

interface UpdateControllerHost {
  state(): UpdateControllerState;
  patch(patch: Partial<UpdateControllerState>): void;
  api(): Pick<Api, "update" | "piUpdate" | "snoozeUpdate"> | null;
  transportGeneration(): number;
  notify(kind: "warning", text: string): void;
}

function checkedStatus(value: unknown): HostUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The Host returned an invalid update status");
  const status = value as Partial<HostUpdateStatus>;
  if (
    !Number.isSafeInteger(status.revision) ||
    Number(status.revision) < 0 ||
    typeof status.inspireUpdateChecking !== "boolean" ||
    typeof status.piUpdateChecking !== "boolean" ||
    (status.inspireUpdateCheck !== null &&
      (typeof status.inspireUpdateCheck !== "object" ||
        Array.isArray(status.inspireUpdateCheck))) ||
    (status.piUpdateCheck !== null &&
      (typeof status.piUpdateCheck !== "object" ||
        Array.isArray(status.piUpdateCheck))) ||
    (status.availableUpdateIdentity !== null &&
      typeof status.availableUpdateIdentity !== "string") ||
    (status.updateSnoozedUntil !== null &&
      (typeof status.updateSnoozedUntil !== "number" ||
        !Number.isFinite(status.updateSnoozedUntil)))
  )
    throw new Error("The Host returned an invalid update status");
  return status as HostUpdateStatus;
}

function projection(status: HostUpdateStatus): Partial<UpdateControllerState> {
  return {
    inspireUpdateCheck: status.inspireUpdateCheck,
    piUpdateCheck: status.piUpdateCheck,
    inspireUpdateChecking: status.inspireUpdateChecking,
    piUpdateChecking: status.piUpdateChecking,
    availableUpdate:
      status.inspireUpdateCheck?.kind === "available"
        ? status.inspireUpdateCheck.update
        : null,
    availableUpdateIdentity: status.availableUpdateIdentity,
    updateSnoozedUntil: status.updateSnoozedUntil,
  };
}

/** Projects the Host-owned update state and owns only browser request races. */
export class UpdateController {
  private requestGeneration = 0;
  private inspireRequest = 0;
  private piRequest = 0;
  private snoozeRequest = 0;
  private statusRevision = -1;
  private snoozing = false;

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    this.requestGeneration += 1;
    this.inspireRequest += 1;
    this.piRequest += 1;
    this.snoozeRequest += 1;
    this.statusRevision = -1;
    this.snoozing = false;
    const state = this.host.state();
    if (state.inspireUpdateChecking || state.piUpdateChecking) {
      this.host.patch({
        inspireUpdateChecking: false,
        piUpdateChecking: false,
      });
    }
  }

  /** Validates and adopts a new Host authority's bootstrap projection. */
  bootstrap(status: unknown): Partial<UpdateControllerState> {
    const checked = checkedStatus(status);
    this.statusRevision = checked.revision;
    return projection(checked);
  }

  /** Reconciles the update witness carried beside every runtime snapshot so a
   * bootstrap-to-WebSocket race cannot strand an older Host projection. */
  applySnapshot(status: unknown): void {
    this.applyStatus(checkedStatus(status));
  }

  /** Returns true for the Host-wide event class, including malformed frames
   * that must fail the connection rather than leave update state divergent. */
  applyEvent(event: WireEvent): boolean {
    if (event.type !== "update_status") return false;
    this.applyStatus(checkedStatus(event.updateStatus));
    return true;
  }

  refreshInspire(): void {
    this.checkInspire();
  }

  refreshPi(): void {
    this.checkPi();
  }

  snooze(): void {
    const api = this.host.api();
    const identity = this.host.state().availableUpdateIdentity;
    if (!api || !identity || this.snoozing) return;
    this.snoozing = true;
    const request = ++this.snoozeRequest;
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    void api.snoozeUpdate(identity).then(
      (status) => {
        if (
          request !== this.snoozeRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.snoozing = false;
        this.applyStatus(checkedStatus(status));
      },
      () => {
        if (
          request !== this.snoozeRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.snoozing = false;
        this.host.notify("warning", "Unable to close the update notice.");
      },
    );
  }

  private owns(
    api: Pick<Api, "update" | "piUpdate" | "snoozeUpdate">,
    requestGeneration: number,
    transportGeneration: number,
  ): boolean {
    return (
      requestGeneration === this.requestGeneration &&
      transportGeneration === this.host.transportGeneration() &&
      api === this.host.api()
    );
  }

  private checkInspire(): void {
    const api = this.host.api();
    if (!api || this.host.state().inspireUpdateChecking) return;
    const request = ++this.inspireRequest;
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    this.host.patch({ inspireUpdateChecking: true });
    void api.update(true).then(
      (result) => {
        if (
          request !== this.inspireRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.applyStatus(checkedStatus(result.updateStatus));
      },
      () => {
        if (
          request !== this.inspireRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.host.patch({ inspireUpdateChecking: false });
      },
    );
  }

  private checkPi(): void {
    const api = this.host.api();
    if (!api || this.host.state().piUpdateChecking) return;
    const request = ++this.piRequest;
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    this.host.patch({ piUpdateChecking: true });
    void api.piUpdate(true).then(
      (result) => {
        if (
          request !== this.piRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.applyStatus(checkedStatus(result.updateStatus));
      },
      () => {
        if (
          request !== this.piRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.host.patch({ piUpdateChecking: false });
      },
    );
  }

  private applyStatus(status: HostUpdateStatus): void {
    if (status.revision < this.statusRevision) return;
    this.statusRevision = status.revision;
    this.host.patch(projection(status));
  }
}
