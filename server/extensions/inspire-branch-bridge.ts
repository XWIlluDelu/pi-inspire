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
  type BranchBridgeRequest,
  type BranchBridgeResult,
} from "../../shared/branch-bridge-protocol.js";

export {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
} from "../../shared/branch-bridge-protocol.js";

const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,200}$/;

function parseRequest(argument: string, workerId: string): BranchBridgeRequest {
  const decoded = decodeBranchBridgeJson(
    argument,
    BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  );
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("invalid bridge request");
  const value = decoded as Record<string, unknown>;
  if (
    value.v !== BRANCH_BRIDGE_VERSION ||
    value.operation !== "navigate" ||
    typeof value.nonce !== "string" ||
    !TOKEN.test(value.nonce) ||
    typeof value.workerId !== "string" ||
    value.workerId !== workerId ||
    typeof value.sessionId !== "string" ||
    !TOKEN.test(value.sessionId) ||
    typeof value.targetId !== "string" ||
    !ENTRY_ID.test(value.targetId) ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "nonce",
          "workerId",
          "sessionId",
          "operation",
          "targetId",
        ].includes(key),
    )
  )
    throw new Error("invalid bridge request");
  return value as unknown as BranchBridgeRequest;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300) || "branch navigation failed";
}

function emitResult(
  ctx: ExtensionCommandContext,
  statusKey: string,
  result: BranchBridgeResult,
): void {
  let text: string;
  try {
    text = encodeBranchBridgeJson(result, BRANCH_BRIDGE_MAX_RESULT_BYTES);
  } catch {
    text = encodeBranchBridgeJson(
      {
        v: BRANCH_BRIDGE_VERSION,
        nonce: result.nonce,
        workerId: result.workerId,
        sessionId: result.sessionId,
        ok: false,
        cancelled: false,
        beforeLeaf: null,
        effectiveLeaf: null,
        error: "branch navigation failed",
      } satisfies BranchBridgeResult,
      BRANCH_BRIDGE_MAX_RESULT_BYTES,
    );
  }
  // This is deliberately the handler's final action. The host uses the
  // subsequent prompt response as the command-completion fence.
  ctx.ui.setStatus(statusKey, text);
}

export default function inspireBranchBridge(pi: ExtensionAPI): void {
  const command = process.env.INSPIRE_BRANCH_COMMAND ?? "";
  const statusKey = process.env.INSPIRE_BRANCH_STATUS_KEY ?? "";
  const workerId = process.env.INSPIRE_BRANCH_WORKER_ID ?? "";
  if (!TOKEN.test(command) || !TOKEN.test(statusKey) || !TOKEN.test(workerId))
    return;

  pi.registerCommand(command, {
    description: "Internal insπre branch navigation bridge",
    handler: async (argument, ctx) => {
      let request: BranchBridgeRequest | null = null;
      let result: BranchBridgeResult = {
        v: BRANCH_BRIDGE_VERSION,
        nonce: "invalid",
        workerId,
        sessionId: "invalid",
        ok: false,
        cancelled: false,
        beforeLeaf: null,
        effectiveLeaf: null,
      };
      try {
        request = parseRequest(argument, workerId);
        result.nonce = request.nonce;
        result.sessionId = request.sessionId;
        if (ctx.mode !== "rpc" || !ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error("branch navigation requires an idle RPC session");
        const currentSessionId = ctx.sessionManager.getSessionId();
        if (currentSessionId !== request.sessionId)
          throw new Error("bridge request belongs to another session");
        if (!ctx.sessionManager.getEntry(request.targetId))
          throw new Error("branch target does not exist");
        result.beforeLeaf = ctx.sessionManager.getLeafId();
        const navigation = await ctx.navigateTree(request.targetId, {
          summarize: false,
        });
        result.cancelled = navigation.cancelled;
        result.effectiveLeaf = ctx.sessionManager.getLeafId();
        result.ok = !navigation.cancelled;
      } catch (error) {
        result.error = boundedError(error);
        if (request) {
          result.nonce = request.nonce;
          result.sessionId = request.sessionId;
        }
      }
      emitResult(ctx, statusKey, result);
    },
  });
}
