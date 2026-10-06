import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  RETRY_STATE_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { requestWorkerStatus } from "./worker-status-request.js";

/** Read the owning worker without creating session content or model input. */
export async function readWorkerRetryState(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
): Promise<boolean> {
  let result: boolean | undefined;
  await requestWorkerStatus(
    rpc,
    bridge,
    sessionId,
    {
      suffix: RETRY_STATE_SUFFIX,
      argument: { v: BRANCH_BRIDGE_VERSION },
      maxArgumentBytes: BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
      maxResultBytes: BRANCH_BRIDGE_MAX_RESULT_BYTES,
      malformedError: new Error("Malformed retry state result"),
    },
    (value) => {
      if (
        result !== undefined ||
        value.v !== BRANCH_BRIDGE_VERSION ||
        typeof value.autoRetryEnabled !== "boolean"
      )
        throw new Error("Malformed retry state result");
      result = value.autoRetryEnabled;
    },
  );
  if (result === undefined)
    throw new Error("Pi did not confirm effective retry state");
  return result;
}
