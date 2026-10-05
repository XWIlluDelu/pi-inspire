import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../shared/branch-bridge-protocol.js";
import {
  PROVIDER_AUTH_LIMIT,
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
  type ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

export async function requestWorkerAuth(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  operation: ProviderAuthOperation,
): Promise<ProviderAuthResult> {
  const nonce = runtimeToken("auth");
  let result: { result: ProviderAuthResult; error?: string } | undefined;
  const event = (event: Record<string, unknown>) => {
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== `${bridge.statusKey}${PROVIDER_AUTH_SUFFIX}`
    )
      return;
    try {
      const value = decodeBranchBridgeJson(
        event.statusText,
        PROVIDER_AUTH_LIMIT,
      ) as Record<string, unknown>;
      if (
        value.nonce !== nonce ||
        value.workerId !== bridge.workerId ||
        value.sessionId !== sessionId
      )
        return;
      result = value as unknown as typeof result;
    } catch {
      result = {
        result: null,
        error: "Pi returned an invalid authentication response",
      };
    }
  };
  rpc.on("event", event);
  try {
    await rpc.request(
      {
        type: "prompt",
        message: `/${bridge.command}${PROVIDER_AUTH_SUFFIX} ${encodeBranchBridgeJson({ ...operation, nonce, workerId: bridge.workerId, sessionId }, PROVIDER_AUTH_LIMIT)}`,
      },
      30_000,
    );
    if (!result)
      throw requestError(
        "Pi did not confirm this authentication operation",
        409,
      );
    if (result.error) throw requestError(result.error, 409);
    return result.result;
  } finally {
    rpc.off("event", event);
  }
}
