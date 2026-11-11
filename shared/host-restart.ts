/** `host` restarts the Host and its own Pi workers. `host-only` preserves those
 * workers, and `all` also restarts the terminal service. */
export type HostRestartScope = "host" | "host-only" | "all";

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
  reason?: string;
  allReason?: string;
  operation: HostRestartOperation | null;
}

export interface HostRestartRequest {
  hostId: string;
  operationId: string;
  scope: HostRestartScope;
  interruptWork?: true;
  skipAttachedStop?: true;
}
