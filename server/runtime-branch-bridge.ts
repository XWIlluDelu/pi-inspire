import {
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeResult,
  decodeBranchBridgeJson,
} from "../shared/branch-bridge-protocol.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

export function newBridgeIdentity(): BranchBridgeIdentity {
  return {
    workerId: runtimeToken("worker"),
    command: runtimeToken("inspire_branch"),
    statusKey: runtimeToken("inspire_branch_status"),
  };
}

export function parseBridgeResult(text: unknown): BranchBridgeResult {
  let value: Record<string, unknown>;
  try {
    const decoded = decodeBranchBridgeJson(
      text,
      BRANCH_BRIDGE_MAX_RESULT_BYTES,
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("not an object");
    value = decoded as Record<string, unknown>;
  } catch {
    throw new Error("Malformed branch bridge result");
  }
  const leaf = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  if (
    value.v !== BRANCH_BRIDGE_VERSION ||
    typeof value.nonce !== "string" ||
    typeof value.workerId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.cancelled !== "boolean" ||
    !leaf(value.beforeLeaf) ||
    !leaf(value.effectiveLeaf) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length > 300)) ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "nonce",
          "workerId",
          "sessionId",
          "ok",
          "cancelled",
          "beforeLeaf",
          "effectiveLeaf",
          "error",
        ].includes(key),
    )
  )
    throw new Error("Malformed branch bridge result");
  return value as unknown as BranchBridgeResult;
}
