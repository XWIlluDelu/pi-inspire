/** `host` replaces owned Pi workers.
 * `all` also restarts terminals. `all-pi` closes current-user Pi processes,
 * including Herdr Pi only in enhanced mode, then restarts Host and terminals.
 * Keep `all` scoped for older clients. */
export type HostRestartScope = "host" | "all" | "all-pi";

export interface HostRestartOperation {
  id: string;
  scope: HostRestartScope;
  /** Explicit authority to interrupt Pi work; absent means idle-only. */
  interruptWork?: true;
  skipAttachedStop?: true;
  phase: "preparing" | "submitted" | "unknown" | "rejected";
  busyReason?: "active-work" | "in-flight-operation" | "restart-pending";
  stopUnconfirmed?: true;
  error?: string;
}

export interface HostRestartStatus {
  hostId: string;
  available: boolean;
  allAvailable: boolean;
  allPiAvailable?: boolean;
  /** Effective Host mode, fixed until this Host is replaced. */
  allPiIncludesHerdr?: boolean;
  reason?: string;
  allReason?: string;
  allPiReason?: string;
  operation: HostRestartOperation | null;
}

export interface HostRestartRequest {
  hostId: string;
  operationId: string;
  scope: HostRestartScope;
  interruptWork?: true;
  skipAttachedStop?: true;
}
