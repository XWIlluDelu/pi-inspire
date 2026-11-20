import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BRANCH_BRIDGE_MAX_ARGUMENT_BYTES,
  BRANCH_BRIDGE_MAX_RESULT_BYTES,
  BRANCH_BRIDGE_VERSION,
  type BranchBridgeRequest,
  type BranchBridgeResult,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  MODEL_REFRESH_SUFFIX,
  MODEL_REFRESH_TIMEOUT_MS,
  PENDING_IMAGE_SUFFIX,
  RETRY_STATE_SUFFIX,
  UI_RELOAD_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";
import { MAX_SESSION_ID_CHARS } from "../../shared/contracts.js";
import {
  CHECKPOINT_CHUNK_CHARS,
  CHECKPOINT_MAX_CHARS,
  CHECKPOINT_MAX_ENTRIES,
  CHECKPOINT_SUFFIX,
  NATIVE_START_SUFFIX,
  type WorkerCheckpoint,
} from "../../shared/worker-checkpoint.js";
import { nativeEntryDigest } from "../native-entry-digest.js";
import { userMessageEvidence } from "../pending-image-evidence.js";
import { registerProviderAuthBridge } from "./provider-auth-bridge.js";
import { registerToolLoadoutBridge } from "./tool-loadout-bridge.js";
import { registerWorkerStatusCommand } from "./worker-status-command.js";

const CHECKPOINT_STATE = Symbol.for("inspire.worker-checkpoint");
type CheckpointState = {
  workerId: string;
  contextGeneration: number;
  published: number;
  run: number;
  tail: string | null;
  leaf: string | null;
};

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
    value.sessionId.length === 0 ||
    value.sessionId.length > MAX_SESSION_ID_CHARS ||
    typeof value.targetId !== "string" ||
    !ENTRY_ID.test(value.targetId) ||
    (value.summarize !== undefined && typeof value.summarize !== "boolean") ||
    (value.customInstructions !== undefined &&
      (typeof value.customInstructions !== "string" ||
        value.customInstructions.length > 2000)) ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "nonce",
          "workerId",
          "sessionId",
          "operation",
          "targetId",
          "summarize",
          "customInstructions",
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

  const owner = { command, statusKey, workerId };
  registerProviderAuthBridge(pi, owner);
  registerToolLoadoutBridge(pi, owner);

  const processState = process as NodeJS.Process & {
    [CHECKPOINT_STATE]?: CheckpointState;
  };
  const previous = processState[CHECKPOINT_STATE];
  const checkpoint =
    previous?.workerId === workerId
      ? previous
      : {
          workerId,
          contextGeneration: 0,
          published: 0,
          run: 0,
          tail: null,
          leaf: null,
        };
  processState[CHECKPOINT_STATE] = checkpoint;
  const checkpointKey = `${statusKey}${CHECKPOINT_SUFFIX}`;

  function publish(ctx: ExtensionContext, sealed: WorkerCheckpoint["sealed"]) {
    if (ctx.mode !== "rpc") return;
    const native = ctx.sessionManager;
    const entries = native.getEntries();
    if (
      checkpoint.published > entries.length ||
      (checkpoint.published > 0 &&
        entries[checkpoint.published - 1]?.id !== checkpoint.tail)
    ) {
      ctx.ui.setStatus(checkpointKey, "Native checkpoint prefix changed");
      return;
    }
    const leaf = native.getLeafId();
    let at = checkpoint.published;
    let next: string | undefined;
    do {
      const bodies: string[] = [];
      let chars = 0;
      while (at < entries.length && bodies.length < CHECKPOINT_MAX_ENTRIES) {
        next ??= JSON.stringify(entries[at]);
        if (chars + next.length > CHECKPOINT_MAX_CHARS) break;
        chars += next.length;
        bodies.push(next);
        next = undefined;
        at += 1;
      }
      if (bodies.length === 0 && at < entries.length) {
        ctx.ui.setStatus(
          checkpointKey,
          "Native checkpoint entry exceeds its bound",
        );
        return;
      }
      const final = at === entries.length;
      const marker: WorkerCheckpoint = {
        workerId,
        contextGeneration: checkpoint.contextGeneration,
        sessionId: native.getSessionId(),
        sessionFile: native.getSessionFile() ?? null,
        from: checkpoint.tail,
        tail: entries[at - 1]?.id ?? null,
        leaf: final ? leaf : checkpoint.leaf,
        run: checkpoint.run,
        sealed: final ? sealed : null,
        entries: bodies.length,
      };
      ctx.ui.setStatus(checkpointKey, JSON.stringify(marker));
      for (const body of bodies)
        for (
          let start = 0;
          start < body.length;
          start += CHECKPOINT_CHUNK_CHARS
        ) {
          const end = start + CHECKPOINT_CHUNK_CHARS;
          ctx.ui.setStatus(
            checkpointKey,
            (end >= body.length ? "!" : "+") + body.slice(start, end),
          );
        }
      checkpoint.published = at;
      checkpoint.tail = marker.tail;
      checkpoint.leaf = marker.leaf;
    } while (at < entries.length);
  }

  pi.on("agent_start", () => {
    checkpoint.run += 1;
  });
  pi.on("turn_start", (_event, ctx) => {
    publish(ctx, "turn");
  });
  pi.on("context", (_event, ctx) => {
    // Pi has persisted the input by the time it assembles model context.
    // Adopt that input before the response so its saved actions are available.
    publish(ctx, "turn");
  });
  pi.on("agent_settled", (_event, ctx) => {
    publish(ctx, "settled");
  });
  pi.registerCommand(`${command}${CHECKPOINT_SUFFIX}`, {
    description: "Internal Inspire native session checkpoint",
    handler: async (_argument, ctx) => {
      publish(ctx, ctx.isIdle() ? "idle" : null);
    },
  });

  pi.on("session_start", (event, ctx) => {
    checkpoint.contextGeneration += 1;
    if (event.reason !== "reload") {
      const initial = ctx.sessionManager.getEntries();
      checkpoint.published = initial.length;
      checkpoint.tail = initial.at(-1)?.id ?? null;
      checkpoint.leaf = ctx.sessionManager.getLeafId();
      const expected = process.env.INSPIRE_NATIVE_START_COUNT;
      if (
        ctx.mode === "rpc" &&
        event.reason === "startup" &&
        expected !== undefined
      ) {
        const count = Math.min(initial.length, Number(expected));
        ctx.ui.setStatus(
          `${statusKey}${NATIVE_START_SUFFIX}`,
          JSON.stringify({
            workerId,
            sessionId: ctx.sessionManager.getSessionId(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            count,
            digest: nativeEntryDigest(initial.slice(0, count)),
          }),
        );
      }
    }
    // This explicit Host extension loads before configured extensions. Clear
    // the prior runtime (including shutdown UI) before their startup handlers.
    if (event.reason === "reload" && ctx.mode === "rpc") {
      ctx.ui.setStatus(
        `${statusKey}${UI_RELOAD_SUFFIX}`,
        encodeBranchBridgeJson(
          {
            v: BRANCH_BRIDGE_VERSION,
            workerId,
            sessionId: ctx.sessionManager.getSessionId(),
          },
          BRANCH_BRIDGE_MAX_RESULT_BYTES,
        ),
      );
    }
    if (ctx.mode === "rpc" && !ctx.isProjectTrusted()) {
      ctx.ui.notify(
        "Pi is skipping trust-protected project settings and resources. Review this folder with /trust in terminal Pi, then Reload this session.",
        "warning",
      );
    }
  });

  registerWorkerStatusCommand(
    pi,
    owner,
    {
      suffix: RETRY_STATE_SUFFIX,
      description: "effective retry state",
      versioned: true,
    },
    (_request, _ctx, emit) => {
      emit({ autoRetryEnabled: pi.getSettings().retry?.enabled ?? true });
    },
  );

  registerWorkerStatusCommand(
    pi,
    owner,
    {
      suffix: PENDING_IMAGE_SUFFIX,
      description: "pending image evidence",
      versioned: true,
    },
    (request, ctx, emit) => {
      if (
        request.since !== undefined &&
        request.since !== null &&
        typeof request.since !== "string"
      )
        throw new Error("invalid pending image cursor");
      const entries = ctx.sessionManager.getEntries();
      if (request.since !== undefined) {
        const start =
          request.since === null
            ? -1
            : entries.findIndex((entry) => entry.id === request.since);
        if (request.since !== null && start < 0)
          throw new Error("Pending image cursor is no longer available");
        for (const entry of entries.slice(start + 1)) {
          if (entry.type !== "message") continue;
          const message = userMessageEvidence(entry.message);
          if (message) emit({ message });
        }
      }
      // No image bodies or old-message hashes cross this boundary. Raw
      // message_start events still own consumption before persistence.
      emit({ cursor: entries.at(-1)?.id ?? null });
    },
  );

  // Catalog refresh is independent of branch navigation and active agent work.
  // ModelRuntime retains extension providers and owns authentication/network policy.
  let refreshing: Promise<string | undefined> | undefined;
  registerWorkerStatusCommand(
    pi,
    owner,
    {
      suffix: MODEL_REFRESH_SUFFIX,
      description: "model catalog refresh",
    },
    async (_request, ctx, emit) => {
      let ok = true;
      let warning: string | undefined;
      try {
        refreshing ??= (async () => {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            MODEL_REFRESH_TIMEOUT_MS,
          );
          try {
            const result = await ctx.modelRegistry.refresh({
              signal: controller.signal,
            });
            return result.aborted
              ? "Model refresh timed out; showing cached models"
              : result.errors.size
                ? "Some model catalogs could not refresh; showing available models"
                : ctx.modelRegistry.getError();
          } finally {
            clearTimeout(timer);
          }
        })().finally(() => {
          refreshing = undefined;
        });
        warning = await refreshing;
      } catch (error) {
        ok = false;
        warning = boundedError(error);
      }
      emit({ ok, ...(warning ? { warning: warning.slice(0, 300) } : {}) });
    },
  );

  let navigating:
    | {
        sessionId: string;
        beforeLeaf: string | null;
        navigationLeaf?: string | null;
        summaryId?: string;
      }
    | undefined;
  pi.on("session_tree", (event, ctx) => {
    if (
      navigating &&
      ctx.sessionManager.getSessionId() === navigating.sessionId &&
      event.oldLeafId === navigating.beforeLeaf
    ) {
      navigating.navigationLeaf = event.newLeafId;
      navigating.summaryId = event.summaryEntry?.id;
    }
  });

  pi.registerCommand(command, {
    description: "Internal Inspire branch navigation bridge",
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
        const witness = {
          sessionId: request.sessionId,
          beforeLeaf: result.beforeLeaf,
        } as NonNullable<typeof navigating>;
        navigating = witness;
        try {
          const navigation = await ctx.navigateTree(request.targetId, {
            summarize: request.summarize ?? false,
            customInstructions: request.customInstructions,
          });
          result.cancelled = navigation.cancelled;
          result.effectiveLeaf = ctx.sessionManager.getLeafId();
          result.ok = !navigation.cancelled;
        } finally {
          result.navigationLeaf = witness.navigationLeaf;
          if (witness.summaryId) result.summaryId = witness.summaryId;
          navigating = undefined;
        }
      } catch (error) {
        result.effectiveLeaf = ctx.sessionManager.getLeafId();
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
