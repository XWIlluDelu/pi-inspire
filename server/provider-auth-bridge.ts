import {
  PROVIDER_AUTH_LIMIT,
  PROVIDER_AUTH_SUFFIX,
  type ProviderAuthOperation,
  type ProviderAuthResult,
} from "../shared/provider-auth-bridge.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { requestWorkerStatus } from "./worker-status-request.js";

export async function requestWorkerAuth(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  operation: ProviderAuthOperation,
): Promise<ProviderAuthResult> {
  let result: { result: ProviderAuthResult; error?: string } | undefined;
  await requestWorkerStatus(
    rpc,
    bridge,
    sessionId,
    {
      suffix: PROVIDER_AUTH_SUFFIX,
      argument: { ...operation },
      maxArgumentBytes: PROVIDER_AUTH_LIMIT,
      maxResultBytes: PROVIDER_AUTH_LIMIT,
      malformedError: requestError(
        "Pi returned an invalid authentication response",
        409,
      ),
    },
    (value) => {
      if (
        result ||
        !Object.hasOwn(value, "result") ||
        (value.error !== undefined && typeof value.error !== "string")
      )
        throw new Error("Invalid authentication response");
      result = value as unknown as typeof result;
    },
  );
  if (!result)
    throw requestError("Pi did not confirm this authentication operation", 409);
  if (result.error) throw requestError(result.error, 409);
  return result.result;
}
