import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

interface StatusRequest {
  suffix: string;
  argument?: Record<string, unknown>;
  maxArgumentBytes: number;
  maxResultBytes: number;
  timeoutMs?: number;
  malformedError: Error;
}

interface WorkerStatusOwner {
  nonce: string;
  workerId: string;
  sessionId: string;
}

export function watchWorkerStatus(
  rpc: PiRpcProcess,
  statusKey: string,
  owner: WorkerStatusOwner,
  maxBytes: number,
  receive: (value: Record<string, unknown>) => void,
  malformed: () => void,
  mismatch?: () => void,
): () => void {
  const onEvent = (event: Record<string, unknown>) => {
    if (
      !event ||
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== statusKey
    )
      return;
    try {
      const value = decodeBranchBridgeJson(event.statusText, maxBytes) as
        | Record<string, unknown>
        | null;
      if (
        !value ||
        value.nonce !== owner.nonce ||
        value.workerId !== owner.workerId ||
        value.sessionId !== owner.sessionId
      ) {
        mismatch?.();
        return;
      }
      receive(value);
    } catch {
      malformed();
    }
  };
  rpc.on("event", onEvent);
  return () => {
    rpc.off("event", onEvent);
  };
}

export function sendWorkerStatusRequest(
  rpc: PiRpcProcess,
  command: string,
  argument: Record<string, unknown>,
  maxBytes: number,
  timeoutMs: number | null,
) {
  return rpc.request(
    {
      type: "prompt",
      message: `/${command} ${encodeBranchBridgeJson(argument, maxBytes)}`,
    },
    timeoutMs,
  );
}

/** The hidden command's prompt receipt fences its status packets. */
export async function requestWorkerStatus(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  options: StatusRequest,
  receive: (value: Record<string, unknown>) => void,
): Promise<void> {
  const owner = { nonce: runtimeToken("status"), workerId: bridge.workerId, sessionId };
  let invalid = false;
  const unwatch = watchWorkerStatus(
    rpc, `${bridge.statusKey}${options.suffix}`, owner, options.maxResultBytes,
    receive, () => { invalid = true; },
  );
  try {
    await sendWorkerStatusRequest(
      rpc, `${bridge.command}${options.suffix}`, { ...options.argument, ...owner },
      options.maxArgumentBytes, options.timeoutMs ?? 30_000,
    );
    if (invalid) throw options.malformedError;
  } finally {
    unwatch();
  }
}
