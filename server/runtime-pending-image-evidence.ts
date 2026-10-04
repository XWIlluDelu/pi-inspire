import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  PENDING_IMAGE_SUFFIX,
} from "../shared/branch-bridge-protocol.js";
import type { UserMessageEvidence } from "./pending-image-evidence.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { runtimeToken } from "./runtime-token.js";

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
  const nonce = runtimeToken("images");
  const messages: UserMessageEvidence[] = [];
  let cursor: string | null | undefined;
  let invalid: Error | undefined;
  const onEvent = (event: Record<string, unknown>) => {
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== `${bridge.statusKey}${PENDING_IMAGE_SUFFIX}`
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
    } catch {
      invalid = new Error("Malformed pending image evidence");
    }
  };
  rpc.on("event", onEvent);
  try {
    await rpc.request(
      {
        type: "prompt",
        message: `/${bridge.command}${PENDING_IMAGE_SUFFIX} ${encodeBranchBridgeJson({ v: BRANCH_BRIDGE_VERSION, nonce, workerId: bridge.workerId, sessionId, ...(since === undefined ? {} : { since }) }, BRANCH_BRIDGE_MAX_ARGUMENT_BYTES)}`,
      },
      30_000,
    );
    if (invalid) throw invalid;
    if (cursor === undefined)
      throw new Error("Pi did not confirm pending image evidence");
    return { cursor, messages };
  } finally {
    rpc.off("event", onEvent);
  }
}
