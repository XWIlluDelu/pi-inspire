type AssistantOutcome = "stopped" | "error" | null;

/** Presentation only: do not rewrite Pi messages or infer cancellation from
 * arbitrary provider/transport errors. Some native cancellation paths persist
 * the standalone default AbortError reason with stopReason:"error". */
export function assistantOutcome(value: unknown): AssistantOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted") return "stopped";
  if (message.stopReason !== "error") return null;
  return typeof message.errorMessage === "string" &&
    message.errorMessage.trim() === "This operation was aborted"
    ? "stopped"
    : "error";
}
