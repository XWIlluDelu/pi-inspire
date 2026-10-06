import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  PENDING_IMAGE_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import type { UserMessageEvidence } from "./pending-image-evidence.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { requestWorkerStatus } from "./worker-status-request.js";

export interface PendingImageEvidence {
  cursor: string | null;
  messages: UserMessageEvidence[];
}

/** Each evidence record is small; the prompt receipt fences the final cursor.
 * An initial read returns only the native append cursor, never historical bytes. */
export async function readPendingImageEvidence(
  rpc: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  since?: string | null,
): Promise<PendingImageEvidence> {
  const messages: UserMessageEvidence[] = [];
  let cursor: string | null | undefined;
  await requestWorkerStatus(
    rpc,
    bridge,
    sessionId,
    {
      suffix: PENDING_IMAGE_SUFFIX,
      argument: {
        v: BRANCH_BRIDGE_VERSION,
        ...(since === undefined ? {} : { since }),
      },
      maxArgumentBytes: BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
      maxResultBytes: BRANCH_BRIDGE_MAX_RESULT_BYTES,
      malformedError: new Error("Malformed pending image evidence"),
    },
    (value) => {
      if (value.v !== BRANCH_BRIDGE_VERSION || cursor !== undefined)
        throw new Error("Malformed image evidence");
      if ("cursor" in value) {
        if (value.cursor !== null && typeof value.cursor !== "string")
          throw new Error("Malformed image cursor");
        cursor = value.cursor;
      } else {
        const message = value.message as UserMessageEvidence | undefined;
        if (
          !message ||
          ![
            message.identity,
            message.fingerprint,
            message.textFingerprint,
          ].every(
            (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
          ) ||
          !Number.isSafeInteger(message.imageCount) ||
          message.imageCount < 0
        )
          throw new Error("Malformed image evidence");
        messages.push(message);
      }
    },
  );
  if (cursor === undefined)
    throw new Error("Pi did not confirm pending image evidence");
  return { cursor, messages };
}
