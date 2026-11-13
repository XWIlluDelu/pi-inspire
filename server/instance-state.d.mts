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
  /** Compatibility marker for the signed instance control protocol. */
  durableWorkerRelease: true;
  systemdInvocationId?: string;
}

export interface ExpectedInstance {
  root: string;
  host: string;
  port: number;
}

export type InspectionResult =
  | { kind: "absent" | "stale" | "unavailable" }
  | { kind: "healthy"; state: InstanceState; url: string };

export type StopResult =
  | { kind: "absent" | "stale" | "unavailable" }
  | { kind: "timeout" | "stopped" | "cleanup-failed"; state: InstanceState };

export function instanceUrl(state: InstanceState): string;
export function instanceLaunchUrl(state: InstanceState, origin?: string): Promise<string | null>;
export function processStartIdentity(
  pid: number,
  signal?: AbortSignal,
): Promise<string>;
export function writeInstanceState(
  path: string,
  state: InstanceState,
): Promise<void>;
export function removeInstanceState(
  path: string,
  owner: InstanceState,
): Promise<void>;
export function consumeStopRequest(path: string): Promise<boolean>;
export function requestInstanceShutdown(path:string,state:InstanceState,timeoutMs?:number):Promise<void>;
export function completeInstanceShutdown(path:string,state:InstanceState,clean:boolean):Promise<void>;
export function instanceShutdownRequested(path:string,state:InstanceState):Promise<boolean>;
export function watchInstanceShutdown(path:string,state:InstanceState,onShutdown:()=>Promise<void>):()=>void;
export function inspectInstance(
  path: string,
  expected: ExpectedInstance,
  options?: { healthTimeoutMs?: number },
): Promise<InspectionResult>;
export function stopManagedInstance(
  path: string,
  expected: ExpectedInstance,
  options?: {
    timeoutMs?: number;
  },
): Promise<StopResult>;
export function portAvailable(host: string, port: number): Promise<boolean>;
