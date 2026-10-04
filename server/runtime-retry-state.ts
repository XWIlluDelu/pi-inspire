import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  RETRY_STATE_SUFFIX,
  type RetryStateRequest,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

/** Read the owning worker without creating session content or model input.
 * The prompt response fences the internal handler's final status result. */
export async function readWorkerRetryState(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
): Promise<boolean> {
  const nonce = runtimeToken("retry");
  let result: boolean | undefined;
  let invalid: Error | undefined;
  const onEvent = (event: Record<string, unknown>) => {
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== `${bridge.statusKey}${RETRY_STATE_SUFFIX}`
    )
      return;
    try {
      const value = decodeBranchBridgeJson(
        event.statusText,
        BRANCH_BRIDGE_MAX_RESULT_BYTES,
      ) as Record<string, unknown>;
      if (
        !value ||
        value.nonce !== nonce ||
        value.workerId !== bridge.workerId ||
        value.sessionId !== sessionId
      )
        return;
      if (
        result !== undefined ||
        value.v !== BRANCH_BRIDGE_VERSION ||
        typeof value.autoRetryEnabled !== "boolean"
      )
        throw new Error("Malformed retry state result");
      result = value.autoRetryEnabled;
    } catch {
      invalid = new Error("Malformed retry state result");
    }
  };
  rpc.on("event", onEvent);
  try {
    await rpc.request(
      {
        type: "prompt",
        message: `/${bridge.command}${RETRY_STATE_SUFFIX} ${encodeBranchBridgeJson(
          {
            v: BRANCH_BRIDGE_VERSION,
            nonce,
            workerId: bridge.workerId,
            sessionId,
          } satisfies RetryStateRequest,
          BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
        )}`,
      },
      30_000,
    );
    if (invalid) throw invalid;
    if (result === undefined)
      throw new Error("Pi did not confirm effective retry state");
    return result;
  } finally {
    rpc.off("event", onEvent);
  }
}
