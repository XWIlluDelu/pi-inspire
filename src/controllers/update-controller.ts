import {
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
  availableUpdateIdentity: string | null;
  updateSnoozedUntil: number | null;
}

type UpdateApi = Pick<Api, "update" | "piUpdate" | "snoozeUpdate">;
type UpdateKind = "inspire" | "pi";

interface UpdateControllerHost {
  state(): UpdateControllerState;
  patch(patch: Partial<UpdateControllerState>): void;
  api(): UpdateApi | null;
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
    availableUpdateIdentity: status.availableUpdateIdentity,
    updateSnoozedUntil: status.updateSnoozedUntil,
  };
}

/** Projects the Host-owned update state and owns only browser request races. */
export class UpdateController {
  private requestGeneration = 0;
  private readonly checkRequests: Record<UpdateKind, number> = {
    inspire: 0,
    pi: 0,
  };
  private snoozeRequest = 0;
  private statusRevision = -1;
  private snoozing = false;

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    this.requestGeneration += 1;
    this.checkRequests.inspire += 1;
    this.checkRequests.pi += 1;
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
    this.check("inspire", (api) => api.update(true));
  }

  refreshPi(): void {
    this.check("pi", (api) => api.piUpdate(true));
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
    api: UpdateApi,
    requestGeneration: number,
    transportGeneration: number,
  ): boolean {
    return (
      requestGeneration === this.requestGeneration &&
      transportGeneration === this.host.transportGeneration() &&
      api === this.host.api()
    );
  }

  private check(
    kind: UpdateKind,
    perform: (api: UpdateApi) => Promise<{ updateStatus: HostUpdateStatus }>,
  ): void {
    const api = this.host.api();
    const checking =
      kind === "inspire"
        ? this.host.state().inspireUpdateChecking
        : this.host.state().piUpdateChecking;
    if (!api || checking) return;
    const request = ++this.checkRequests[kind];
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    const patchChecking = (value: boolean) =>
      this.host.patch(
        kind === "inspire"
          ? { inspireUpdateChecking: value }
          : { piUpdateChecking: value },
      );
    patchChecking(true);
    void perform(api).then(
      (result) => {
        if (
          request !== this.checkRequests[kind] ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.applyStatus(checkedStatus(result.updateStatus));
      },
      () => {
        if (
          request !== this.checkRequests[kind] ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        patchChecking(false);
      },
    );
  }

  private applyStatus(status: HostUpdateStatus): void {
    if (status.revision < this.statusRevision) return;
    this.statusRevision = status.revision;
    this.host.patch(projection(status));
  }
}
