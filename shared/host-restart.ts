import { z } from "zod";
import type { OperationReceipt } from "./host-operations.js";

export const HOST_RESTART_PATH = "/api/host/restart";

/** Replaces Inspire, its Pi workers, and in-process project terminals. */
export type HostRestartScope = "host";

export interface HostRestartOperation {
  id: string;
  scope: HostRestartScope;
  /** Explicit authority to interrupt Pi work; absent means idle-only. */
  interruptWork?: true;
  skipAttachedStop?: true;
  phase: "preparing" | "submitted" | "unknown" | "rejected";
  busyReason?: "active-work" | "in-flight-operation" | "restart-pending";
  stopUnconfirmed?: true;
  error?: string;
}

export interface HostRestartStatus {
  hostId: string;
  available: boolean;
  reason?: string;
  operation: HostRestartOperation | null;
}

export function canStartHostRestart(
  operation: HostRestartOperation | null | undefined,
): boolean {
  return !operation || operation.phase === "rejected";
}

export const hostRestartRequestSchema = z
  .object({
    hostId: z.string().uuid(),
    operationId: z.string().uuid(),
    scope: z.literal("host"),
    interruptWork: z.literal(true).optional(),
    skipAttachedStop: z.literal(true).optional(),
  })
  .strict()
  .refine(
    ({ interruptWork, skipAttachedStop }) =>
      !skipAttachedStop || interruptWork === true,
    "Confirm which Pi work may be interrupted before restarting.",
  );

export type HostRestartRequest = z.output<typeof hostRestartRequestSchema>;

export function restartReceiptIdentity(intent: HostRestartRequest) {
  return {
    executor: { kind: "lifecycle", hostId: intent.hostId } as const,
    operationId: intent.operationId,
    command: "restart" as const,
  };
}

export function matchesRestartIntent(
  operation: Record<string, unknown> | HostRestartOperation | null,
  intent: HostRestartRequest,
): boolean {
  return (
    operation?.id === intent.operationId &&
    operation.scope === intent.scope &&
    operation.interruptWork === intent.interruptWork &&
    operation.skipAttachedStop === intent.skipAttachedStop
  );
}

export function restartObservation(
  intent: HostRestartRequest,
  result: HostRestartOperation,
) {
  const receipt = { ...restartReceiptIdentity(intent), result };
  // Submission is a process handoff. Only observation of a replacement Host
  // can settle the restart as completed.
  switch (result.phase) {
    case "preparing":
    case "submitted":
      return { ...receipt, state: "pending" } as const;
    case "unknown":
    case "rejected":
      return {
        ...receipt,
        state: result.phase,
        error: {
          status: result.phase === "unknown" ? 503 : 409,
          message: result.error ?? "Restart was not confirmed.",
        },
      } satisfies OperationReceipt<
        typeof receipt.executor,
        "restart",
        HostRestartOperation
      > & { result: HostRestartOperation };
  }
}
