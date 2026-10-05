import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
  MODEL_REFRESH_TIMEOUT_MS,
} from "../shared/branch-bridge-protocol.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

/** Public extension command + its final status are fenced by the RPC prompt
 * response. This does not enter the model, persistence, or branch mutation lane. */
export async function refreshWorkerCatalog(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
): Promise<string | undefined> {
  const nonce = runtimeToken("models");
  let result: { ok: boolean; warning?: string } | undefined;
  let invalid: Error | undefined;
  const onEvent = (event: Record<string, unknown>) => {
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== `${bridge.statusKey}${MODEL_REFRESH_SUFFIX}`
    )
      return;
    try {
      const value = decodeBranchBridgeJson(event.statusText, 2_048) as Record<
        string,
        unknown
      >;
      if (
        !value ||
        value.nonce !== nonce ||
        value.workerId !== bridge.workerId ||
        value.sessionId !== sessionId
      )
        return;
      if (
        result ||
        typeof value.ok !== "boolean" ||
        (value.warning !== undefined &&
          (typeof value.warning !== "string" || value.warning.length > 300))
      )
        throw new Error("Malformed model refresh result");
      result = value as { ok: boolean; warning?: string };
    } catch {
      invalid = new Error("Malformed model refresh result");
    }
  };
  rpc.on("event", onEvent);
  try {
    await rpc.request(
      {
        type: "prompt",
        message: `/${bridge.command}${MODEL_REFRESH_SUFFIX} ${encodeBranchBridgeJson({ nonce, workerId: bridge.workerId, sessionId }, 4_096)}`,
      },
      MODEL_REFRESH_TIMEOUT_MS + 5_000,
    );
    if (invalid) throw invalid;
    if (!result) throw new Error("Pi did not confirm model refresh");
    if (!result.ok) throw new Error(result.warning ?? "Model refresh failed");
    return result.warning;
  } finally {
    rpc.off("event", onEvent);
  }
}
