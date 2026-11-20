import {
  PROVIDER_AUTH_LIMIT,
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
  type ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import { requestError } from "./request-error.js";
import {
  MODEL_REFRESH_SUFFIX,
  MODEL_REFRESH_TIMEOUT_MS,
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

interface StatusRequest {
  suffix: string;
  argument?: Record<string, unknown>;
  maxArgumentBytes?: number;
  maxResultBytes?: number;
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
    rpc,
    `${bridge.statusKey}${options.suffix}`,
    owner,
    options.maxResultBytes ?? BRANCH_BRIDGE_MAX_RESULT_BYTES,
    receive,
    () => {
      invalid = true;
    },
  );
  try {
    await sendWorkerStatusRequest(
      rpc,
      `${bridge.command}${options.suffix}`,
      { ...options.argument, ...owner },
      options.maxArgumentBytes ?? BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
      options.timeoutMs ?? 30_000,
    );
    if (invalid) throw options.malformedError;
  } finally {
    unwatch();
  }
}

/** A single-reply command must produce exactly one matching packet before its RPC receipt. */
export async function workerStatusReply(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  options: StatusRequest,
  missing = options.malformedError,
): Promise<Record<string, unknown>> {
  let reply: Record<string, unknown> | undefined;
  await requestWorkerStatus(rpc, bridge, sessionId, options, (packet) => {
    if (reply) throw options.malformedError;
    reply = packet;
  });
  if (!reply) throw missing;
  return reply;
}

export async function refreshWorkerCatalog(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
) {
  const malformed = new Error("Malformed model refresh result");
  const { ok, warning } = await workerStatusReply(
    rpc,
    bridge,
    sessionId,
    {
      suffix: MODEL_REFRESH_SUFFIX,
      maxArgumentBytes: 4_096,
      timeoutMs: MODEL_REFRESH_TIMEOUT_MS + 5_000,
      malformedError: malformed,
    },
    new Error("Pi did not confirm model refresh"),
  );
  if (
    typeof ok !== "boolean" ||
    (warning !== undefined &&
      (typeof warning !== "string" || warning.length > 300))
  )
    throw malformed;
  if (!ok) throw new Error(warning ?? "Model refresh failed");
  return warning;
}

export async function requestWorkerAuth(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  operation: ProviderAuthOperation,
): Promise<ProviderAuthResult> {
  const malformed = requestError(
    "Pi returned an invalid authentication response",
    409,
  );
  const packet = await workerStatusReply(
    rpc,
    bridge,
    sessionId,
    {
      suffix: PROVIDER_AUTH_SUFFIX,
      argument: operation,
      maxArgumentBytes: PROVIDER_AUTH_LIMIT,
      maxResultBytes: PROVIDER_AUTH_LIMIT,
      malformedError: malformed,
    },
    requestError("Pi did not confirm this authentication operation", 409),
  );
  if (
    !Object.hasOwn(packet, "result") ||
    (packet.error !== undefined && typeof packet.error !== "string")
  )
    throw malformed;
  if (packet.error) throw requestError(packet.error, 409);
  return packet.result as ProviderAuthResult;
}
