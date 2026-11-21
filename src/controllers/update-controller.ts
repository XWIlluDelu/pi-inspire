import {
  type HostUpdateStatus,
  UPDATE_SNOOZE_MS,
} from "../../shared/contracts";
import type { Api } from "../api";
import type { WireEvent } from "../events";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";

interface UpdateControllerState extends Omit<HostUpdateStatus, "revision"> {
  inspireUpdateRequestPending: boolean;
  piUpdateRequestPending: boolean;
  inspireUpdateRequestError: string | null;
  piUpdateRequestError: string | null;
}

type UpdateApi = Pick<Api, "json">;
const UPDATE_KINDS = ["inspire", "pi"] as const;
type UpdateKind = (typeof UPDATE_KINDS)[number];

interface UpdateControllerHost {
  state(): UpdateControllerState;
  patch(patch: Partial<UpdateControllerState>): void;
  api(): UpdateApi | null;
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

/** Projects Host-owned checks and owns browser request feedback and recovery. */
export class UpdateController {
  private readonly checks = new Map<UpdateKind, RecoveryBackoff>();
  private statusRevision = -1;
  private dismissal?: { identity: string; until: number };

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    for (const kind of UPDATE_KINDS) this.retireCheck(kind);
    this.statusRevision = -1;
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
      ...this.project(checked),
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
    this.check("inspire");
  }

  refreshPi(): void {
    this.check("pi");
  }

  snooze = (): void => {
    const api = this.host.api();
    const { availableUpdateIdentity: identity, updateSnoozedUntil } = this.host.state();
    if (!identity || updateSnoozedUntil !== null) return;
    const dismissal = { identity, until: Date.now() + UPDATE_SNOOZE_MS };
    this.dismissal = dismissal;
    this.host.patch({ updateSnoozedUntil: dismissal.until });
    setTimeout(() => {
      if (this.dismissal !== dismissal) return;
      this.dismissal = undefined;
      if (this.host.state().availableUpdateIdentity === identity)
        this.host.patch({ updateSnoozedUntil: null });
    }, UPDATE_SNOOZE_MS);
    void api
      ?.json("snoozeUpdate", { body: { identity } })
      .then((status) => {
        if (api === this.host.api()) this.applyStatus(checkedStatus(status));
      })
      .catch(() => {});
  };

  private project(status: HostUpdateStatus): Partial<UpdateControllerState> {
    const local = this.dismissal?.identity === status.availableUpdateIdentity
      ? this.dismissal
      : undefined;
    if (local && status.updateSnoozedUntil !== null) this.dismissal = undefined;
    return {
      inspireUpdateCheck: status.inspireUpdateCheck,
      piUpdateCheck: status.piUpdateCheck,
      inspireUpdateChecking: status.inspireUpdateChecking,
      piUpdateChecking: status.piUpdateChecking,
      availableUpdateIdentity: status.availableUpdateIdentity,
      updateSnoozedUntil: status.updateSnoozedUntil ??
        (local && local.until > Date.now() ? local.until : null),
    };
  }

  private retireCheck(kind: UpdateKind): void {
    this.checks.get(kind)?.cancel();
    this.checks.delete(kind);
  }

  private check(kind: UpdateKind): void {
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
        const result = await api.json("checkUpdates", {
          query: { kind, refresh: "1" },
        });
        if (!owns()) return;
        const status = checkedStatus(result);
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
    const patch = this.project(status);
    for (const kind of UPDATE_KINDS) {
      if (!status[`${kind}UpdateChecking`]) continue;
      this.retireCheck(kind);
      patch[`${kind}UpdateRequestPending`] = false;
      patch[`${kind}UpdateRequestError`] = null;
    }
    this.host.patch(patch);
  }
}
