export const INSTANCE_STATE_VERSION: 1;

export interface InstanceState {
  schemaVersion: 1;
  pid: number;
  root: string;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  processStartTime: string;
  mock: boolean;
}

export interface ExpectedInstance {
  root: string;
  host: string;
  port: number;
  mock?: boolean;
}

export type InspectionResult =
  | { kind: "absent" | "stale" }
  | { kind: "mode-conflict" | "unavailable"; state: InstanceState }
  | { kind: "healthy"; state: InstanceState; url: string };

export type StopResult =
  | { kind: "absent" | "stale" }
  | { kind: "unavailable" | "timeout" | "stopped"; state: InstanceState };

export function instanceUrl(state: InstanceState): string;
export function processStartIdentity(pid: number): Promise<string>;
export function writeInstanceState(
  path: string,
  state: InstanceState,
): Promise<void>;
export function removeInstanceState(
  path: string,
  owner: InstanceState,
): Promise<void>;
export function consumeStopRequest(path: string): Promise<boolean>;
export function inspectInstance(
  path: string,
  expected: ExpectedInstance,
  options?: { processMarker?: string; healthTimeoutMs?: number },
): Promise<InspectionResult>;
export function stopManagedInstance(
  path: string,
  expected: ExpectedInstance,
  options?: {
    processMarker?: string;
    healthTimeoutMs?: number;
    timeoutMs?: number;
  },
): Promise<StopResult>;
export function portAvailable(host: string, port: number): Promise<boolean>;
