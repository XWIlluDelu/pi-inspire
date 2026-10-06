import {
  MODEL_REFRESH_SUFFIX,
  MODEL_REFRESH_TIMEOUT_MS,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { requestWorkerStatus } from "./worker-status-request.js";

/** Refresh does not enter the model, persistence, or branch mutation lane. */
export async function refreshWorkerCatalog(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
): Promise<string | undefined> {
  let result: { ok: boolean; warning?: string } | undefined;
  await requestWorkerStatus(
    rpc,
    bridge,
    sessionId,
    {
      suffix: MODEL_REFRESH_SUFFIX,
      maxArgumentBytes: 4_096,
      maxResultBytes: 2_048,
      timeoutMs: MODEL_REFRESH_TIMEOUT_MS + 5_000,
      malformedError: new Error("Malformed model refresh result"),
    },
    (value) => {
      if (
        result ||
        typeof value.ok !== "boolean" ||
        (value.warning !== undefined &&
          (typeof value.warning !== "string" || value.warning.length > 300))
      )
        throw new Error("Malformed model refresh result");
      result = value as { ok: boolean; warning?: string };
    },
  );
  if (!result) throw new Error("Pi did not confirm model refresh");
  if (!result.ok) throw new Error(result.warning ?? "Model refresh failed");
  return result.warning;
}
