import type { InstanceState } from "./instance-state.mjs";

export type InstanceControlAction =
  | "readiness"
  | "launch-url"
  | "maintenance-prepare"
  | "maintenance-commit"
  | "maintenance-release";

export interface InstanceControlRequest {
  version: 1;
  nonce: string;
  expiresAt: number;
  action: InstanceControlAction;
  payload: Record<string, unknown>;
  proof: string;
}

export interface InstanceControlGrant {
  state: InstanceState;
  request: Omit<InstanceControlRequest, "proof">;
}

export interface InstanceControlResponse {
  version: 1;
  nonce: string;
  result: unknown;
  proof: string;
}

export function instanceIdentity(state: InstanceState): string;
export function createInstanceControlRequest(
  state: InstanceState,
  action: InstanceControlAction,
  payload?: Record<string, unknown>,
  timeoutMs?: number,
): InstanceControlRequest;

export class InstanceHttpControl {
  constructor(now?: () => number);
  accept(
    state: InstanceState | null,
    value: unknown,
  ): InstanceControlGrant | null;
  reply(grant: InstanceControlGrant, result: unknown): InstanceControlResponse;
}

export function verifyInstanceControlResponse(
  state: InstanceState,
  request: InstanceControlRequest,
  value: unknown,
): boolean;
export function requestInstanceControl(
  state: InstanceState,
  action: InstanceControlAction,
  payload?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown | null>;
