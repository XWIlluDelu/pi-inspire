import type { SessionEntry } from "@earendil-works/pi-coding-agent";
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

/** The native anchor may include its summary/label prefix; subsequent entries
 * are extension effects. Callers separately attest worker identity and disk JSON. */
export function branchDeltaMatches(
  result: BranchBridgeResult,
  delta: readonly SessionEntry[],
  navigationTarget: string | null,
  beforeLeaf: string | null,
): boolean {
  if (result.navigationLeaf === undefined || result.beforeLeaf !== beforeLeaf)
    return false;
  let parent = navigationTarget;
  let anchorSeen = result.navigationLeaf === parent;
  for (const [index, entry] of delta.entries()) {
    if (entry.parentId !== parent) return false;
    if (
      !anchorSeen &&
      entry.type !== "label" &&
      !(
        index === 0 &&
        entry.type === "branch_summary" &&
        entry.id === result.summaryId &&
        entry.fromId === beforeLeaf
      )
    )
      return false;
    if (entry.id === result.navigationLeaf) anchorSeen = true;
    parent = entry.id;
  }
  if (
    result.summaryId &&
    !(
      delta[0]?.type === "branch_summary" &&
      delta[0].id === result.summaryId &&
      delta[0].fromId === beforeLeaf
    )
  )
    return false;
  return anchorSeen && parent === result.effectiveLeaf;
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
    (value.navigationLeaf !== undefined && !leaf(value.navigationLeaf)) ||
    (value.summaryId !== undefined &&
      (typeof value.summaryId !== "string" || !value.summaryId)) ||
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
          "navigationLeaf",
          "summaryId",
          "error",
        ].includes(key),
    )
  )
    throw new Error("Malformed branch bridge result");
  return value as unknown as BranchBridgeResult;
}
