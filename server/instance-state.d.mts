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
  shutdownControlVersion?: 1;
  scopedShutdown?: true;
  systemdInvocationId?: string;
  httpControlVersion?: 1;
}

export interface ExpectedInstance {
  root: string;
  host: string;
  port: number;
}

export type InspectionResult =
  | { kind: "absent" | "stale" }
  | { kind: "unavailable"; state: InstanceState }
  | { kind: "healthy"; state: InstanceState; url: string };

export type StopResult =
  | { kind: "absent" | "stale" }
  | { kind: "unavailable" | "timeout" | "stopped" | "cleanup-failed"; state: InstanceState };

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
export function requestInstanceShutdown(path:string,state:InstanceState,timeoutMs?:number,scope?:"host-only"):Promise<string>;
export function completeInstanceShutdown(path:string,state:InstanceState,clean:boolean,requestNonce?:string):Promise<void>;
export function instanceShutdownRequested(path:string,state:InstanceState):Promise<boolean>;
export function watchInstanceShutdown(path:string,state:InstanceState,onShutdown:(request:{nonce:string;scope?:"host-only"})=>Promise<void>):()=>void;
export function inspectInstance(
  path: string,
  expected: ExpectedInstance,
  options?: { processMarker?: string; healthTimeoutMs?: number },
): Promise<InspectionResult>;
export function prepareInstanceRestart(
  path: string,
  expected: { root: string; host: string; port: number },
  scope: "host" | "host-only",
  options?: { processMarker?: string },
): Promise<unknown>;
export function stopManagedInstance(
  path: string,
  expected: ExpectedInstance,
  options?: {
    processMarker?: string;
    healthTimeoutMs?: number;
    timeoutMs?: number;
    scopedOwner?: InstanceState;
  },
): Promise<StopResult>;
export function portAvailable(host: string, port: number): Promise<boolean>;
