import {
  type HostUpdateStatus,
  type PiUpdateCheckResponse,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import type { Api } from "../api";
import type { WireEvent } from "../events";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";

interface UpdateControllerState {
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  inspireUpdateRequestPending: boolean;
  piUpdateRequestPending: boolean;
  inspireUpdateRequestError: string | null;
  piUpdateRequestError: string | null;
  availableUpdateIdentity: string | null;
  updateSnoozedUntil: number | null;
}

type UpdateApi = Pick<Api, "update" | "piUpdate" | "snoozeUpdate">;
const UPDATE_KINDS = ["inspire", "pi"] as const;
type UpdateKind = (typeof UPDATE_KINDS)[number];

interface UpdateControllerHost {
  state(): UpdateControllerState;
  patch(patch: Partial<UpdateControllerState>): void;
  api(): UpdateApi | null;
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

/** Projects Host-owned checks and owns browser request feedback and recovery. */
export class UpdateController {
  private readonly checks = new Map<UpdateKind, RecoveryBackoff>();
  private statusRevision = -1;
  private snoozeIntent: { identity: string } | null = null;

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    for (const kind of UPDATE_KINDS) this.retireCheck(kind);
    this.statusRevision = -1;
    this.snoozeIntent = null;
    // Losing this request's transport cannot declare the Host's work finished.
    this.host.patch({
      inspireUpdateRequestPending: false,
      piUpdateRequestPending: false,
      inspireUpdateRequestError: null,
      piUpdateRequestError: null,
    });
  }

  /** Validates and adopts a new Host authority's bootstrap projection. */
  bootstrap(status: unknown): Partial<UpdateControllerState> {
    const checked = checkedStatus(status);
    this.statusRevision = checked.revision;
    return {
      ...projection(checked),
      inspireUpdateRequestError: null,
      piUpdateRequestError: null,
    };
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
    if (!api || !identity || this.snoozeIntent) return;
    const intent = { identity };
    this.snoozeIntent = intent;
    const owns = () => this.snoozeIntent === intent && api === this.host.api();
    void api
      .snoozeUpdate(intent.identity)
      .then((status) => {
        if (!owns()) return;
        this.applyStatus(checkedStatus(status));
      })
      .catch(() => {
        if (owns())
          this.host.notify("warning", "Unable to close the update notice.");
      })
      .finally(() => {
        if (this.snoozeIntent === intent) this.snoozeIntent = null;
      });
  }

  private retireCheck(kind: UpdateKind): void {
    this.checks.get(kind)?.cancel();
    this.checks.delete(kind);
  }

  private check(
    kind: UpdateKind,
    perform: (api: UpdateApi) => Promise<{ updateStatus: HostUpdateStatus }>,
  ): void {
    const api = this.host.api();
    const state = this.host.state();
    const pendingField = `${kind}UpdateRequestPending` as const;
    const errorField = `${kind}UpdateRequestError` as const;
    if (!api || state[`${kind}UpdateChecking`] || state[pendingField]) return;
    const recovery = new RecoveryBackoff();
    this.checks.set(kind, recovery);
    const owns = () =>
      this.checks.get(kind) === recovery && api === this.host.api();
    const patchRequest = (value: boolean, error: string | null = null) =>
      this.host.patch({ [pendingField]: value, [errorField]: error });
    const run = async () => {
      if (!owns()) return;
      try {
        const result = await perform(api);
        if (!owns()) return;
        const status = checkedStatus(result.updateStatus);
        this.retireCheck(kind);
        patchRequest(false);
        this.applyStatus(status);
      } catch (error) {
        // A Host observation can acknowledge this check before HTTP settles.
        // Its work remains authoritative even if the response is lost later.
        if (!owns()) return;
        if (isTransientFailure(error) && recovery.schedule(() => void run()))
          return;
        this.retireCheck(kind);
        patchRequest(
          false,
          kind === "inspire"
            ? "Couldn't check INSΠRE updates."
            : "Couldn't check Pi and extension updates.",
        );
      }
    };
    patchRequest(true);
    void run();
  }

  private applyStatus(status: HostUpdateStatus): void {
    if (status.revision < this.statusRevision) return;
    this.statusRevision = status.revision;
    const patch = projection(status);
    for (const kind of UPDATE_KINDS) {
      if (!status[`${kind}UpdateChecking`]) continue;
      this.retireCheck(kind);
      patch[`${kind}UpdateRequestPending`] = false;
      patch[`${kind}UpdateRequestError`] = null;
    }
    this.host.patch(patch);
  }
}
