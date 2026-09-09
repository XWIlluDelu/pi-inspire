export type HostRestartScope = "host" | "all";

export interface HostRestartOperation {
  id: string;
  scope: HostRestartScope;
  phase: "preparing" | "submitted" | "unknown" | "rejected";
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
}
