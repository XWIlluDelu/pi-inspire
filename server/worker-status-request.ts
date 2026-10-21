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

/** The hidden command's prompt receipt fences its status packets. Callers own
 * packet validation/completion, including multi-packet evidence ordering. */
export async function requestWorkerStatus(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  options: StatusRequest,
  receive: (value: Record<string, unknown>) => void,
): Promise<void> {
  const nonce = runtimeToken("status");
  let invalid = false;
  const onEvent = (event: Record<string, unknown>) => {
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== `${bridge.statusKey}${options.suffix}`
    )
      return;
    try {
      const value = decodeBranchBridgeJson(
        event.statusText,
        options.maxResultBytes,
      ) as Record<string, unknown> | null;
      if (
        !value ||
        value.nonce !== nonce ||
        value.workerId !== bridge.workerId ||
        value.sessionId !== sessionId
      )
        return;
      receive(value);
    } catch {
      invalid = true;
    }
  };
  rpc.on("event", onEvent);
  try {
    await rpc.request(
      {
        type: "prompt",
        message: `/${bridge.command}${options.suffix} ${encodeBranchBridgeJson(
          { ...options.argument, nonce, workerId: bridge.workerId, sessionId },
          options.maxArgumentBytes,
        )}`,
      },
      options.timeoutMs ?? 30_000,
    );
    if (invalid) throw options.malformedError;
  } finally {
    rpc.off("event", onEvent);
  }
}
