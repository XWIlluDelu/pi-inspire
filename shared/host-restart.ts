import { z } from "zod";
import type { OperationReceipt } from "./host-operations.js";

export const HOST_RESTART_PATH = "/api/host/restart";

/** `host` replaces owned Pi workers.
 * `all` also restarts terminals. `all-pi` closes current-user Pi processes,
 * including Herdr Pi only in enhanced mode, then restarts Host and terminals.
 * Keep `all` scoped for older clients. */
export type HostRestartScope = "host" | "all" | "all-pi";

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
  allAvailable: boolean;
  allPiAvailable?: boolean;
  /** Effective Host mode, fixed until this Host is replaced. */
  allPiIncludesHerdr?: boolean;
  reason?: string;
  allReason?: string;
  allPiReason?: string;
  operation: HostRestartOperation | null;
}

export const hostRestartRequestSchema = z
  .object({
    hostId: z.string().uuid(),
    operationId: z.string().uuid(),
    scope: z.enum(["host", "all", "all-pi"]),
    interruptWork: z.literal(true).optional(),
    skipAttachedStop: z.literal(true).optional(),
  })
  .strict()
  .refine(
    ({ scope, interruptWork, skipAttachedStop }) =>
      (scope !== "all-pi" && !skipAttachedStop) || interruptWork === true,
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
