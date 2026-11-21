import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../../shared/branch-bridge-protocol.js";
import { jsonRecord } from "../../shared/json-record.js";
import type { BranchBridgeIdentity } from "../runtime-slot.js";

export function registerWorkerStatusCommand(
  pi: ExtensionAPI,
  { command, statusKey, workerId }: BranchBridgeIdentity,
  options: {
    suffix: string;
    description: string;
    argumentLimit?: number;
    resultLimit?: number;
    versioned?: boolean;
  },
  handle: (
    request: Record<string, unknown>,
    ctx: ExtensionCommandContext,
    emit: (result: object) => void,
  ) => void | Promise<void>,
): void {
  pi.registerCommand(command + options.suffix, {
    description: `Internal Inspire ${options.description}`,
    handler: async (encoded, ctx) => {
      const request = jsonRecord(
        decodeBranchBridgeJson(
          encoded,
          options.argumentLimit ?? BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
        ),
      );
      const sessionId = ctx.sessionManager.getSessionId();
      if (
        ctx.mode !== "rpc" ||
        request?.workerId !== workerId ||
        request.sessionId !== sessionId ||
        typeof request.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{16,200}$/u.test(request.nonce) ||
        (options.versioned && request.v !== BRANCH_BRIDGE_VERSION)
      )
        throw new Error("invalid worker status owner");
      const owner = { nonce: request.nonce, workerId, sessionId };
      await handle(request, ctx, (result) =>
        ctx.ui.setStatus(
          statusKey + options.suffix,
          encodeBranchBridgeJson(
            {
              ...result,
              ...owner,
              ...(options.versioned ? { v: BRANCH_BRIDGE_VERSION } : {}),
            },
            options.resultLimit ?? BRANCH_BRIDGE_MAX_RESULT_BYTES,
          ),
        ),
      );
    },
  });
}
