import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeRequest,
  type BranchBridgeResult,
} from "../shared/branch-bridge-protocol.js";
import { isPiRpcOutcomeUnknown, type PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";
import {
  sendWorkerStatusRequest,
  watchWorkerStatus,
} from "./worker-status-request.js";

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

function parseBridgeResult(value: Record<string, unknown>): BranchBridgeResult {
  const leaf = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  if (
    value.v !== BRANCH_BRIDGE_VERSION ||
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

export function startBranchNavigation(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  request: Omit<BranchBridgeRequest, "v" | "nonce" | "workerId">,
  timeoutMs: number | null,
) {
  const owner = {
    nonce: runtimeToken("nonce"),
    workerId: bridge.workerId,
    sessionId: request.sessionId,
  };
  const {
    promise: result,
    resolve,
    reject,
  } = Promise.withResolvers<BranchBridgeResult>();
  let received = false;
  let duplicate = false;
  const receive = (value?: Record<string, unknown>) => {
    if (received) {
      duplicate = true;
      return;
    }
    received = true;
    try {
      if (!value) throw new Error("Invalid branch bridge result");
      resolve(parseBridgeResult(value));
    } catch (error) {
      reject(error);
    }
  };
  const unwatch = watchWorkerStatus(
    rpc,
    bridge.statusKey,
    owner,
    BRANCH_BRIDGE_MAX_RESULT_BYTES,
    receive,
    () => receive(),
    () => receive(),
  );
  const finished = Promise.resolve()
    .then(() =>
      sendWorkerStatusRequest(
        rpc,
        bridge.command,
        { ...request, ...owner, v: BRANCH_BRIDGE_VERSION },
        BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
        timeoutMs,
      ),
    )
    .then(
      () => {
        if (!received)
          reject(
            new Error("Pi completed the branch command without its result"),
          );
      },
      (error: unknown) => {
        reject(error);
        throw error;
      },
    )
    .finally(unwatch);
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () => reject(new Error("Timed out waiting for branch bridge result")),
          timeoutMs,
        );
  timer?.unref();
  const completion = Promise.allSettled([result, finished]).then(
    ([reply, command]) => {
      clearTimeout(timer);
      if (
        command.status === "rejected" &&
        reply.status === "rejected" &&
        !isPiRpcOutcomeUnknown(command.reason)
      )
        throw command.reason;
      return duplicate ||
        reply.status === "rejected" ||
        command.status === "rejected"
        ? null
        : reply.value;
    },
  );
  return { result, finished, completion, reject };
}
