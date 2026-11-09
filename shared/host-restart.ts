/** `host` also reloads the Pi processes Inspire has taken over; `host-only`
 * leaves every Pi outside the Host as it is; `all` adds terminal services. */
export type HostRestartScope = "host" | "host-only" | "all";

export interface HostRestartOperation {
  id: string;
  scope: HostRestartScope;
  /** Explicit authority to interrupt Pi work; absent means idle-only. */
  interruptWork?: true;
  phase: "preparing" | "submitted" | "unknown" | "rejected";
  busyReason?: "active-work" | "in-flight-operation" | "restart-pending";
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
}
