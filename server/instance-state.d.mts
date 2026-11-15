import { INSTANCE_STATE_VERSION } from "./instance-control.mjs";

export { INSTANCE_STATE_VERSION };

export interface InstanceState {
  schemaVersion: typeof INSTANCE_STATE_VERSION;
  pid: number;
  root: string;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  processStartTime: string;
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
type ProcessIncarnation = Pick<InstanceState, "pid" | "processStartTime">;
export function observeProcessExit(
  owner: ProcessIncarnation,
  timeoutMs: number,
): Promise<boolean>;
export function processMayBeLive(
  owner: ProcessIncarnation,
  signal?: AbortSignal,
): Promise<boolean>;
export function readInstanceState(path: string): Promise<InstanceState | null>;
export function assertInstanceTarget(path: string, target: InstanceState): Promise<void>;
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
    target?: InstanceState;
  },
): Promise<StopResult>;
export function portAvailable(host: string, port: number): Promise<boolean>;
