type AssistantOutcome = "stopped" | "error" | null;

/** Classify the native stop reason without interpreting diagnostic text. */
export function assistantOutcome(value: unknown): AssistantOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted") return "stopped";
  return message.stopReason === "error" ? "error" : null;
}
