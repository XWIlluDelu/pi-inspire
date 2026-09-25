export type HostRestartScope = "host" | "all";

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
  reason?: string;
  operation: HostRestartOperation | null;
}

export interface HostRestartRequest {
  hostId: string;
  operationId: string;
  scope: HostRestartScope;
  interruptWork?: true;
}
