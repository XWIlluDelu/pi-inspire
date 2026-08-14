/** Correlation used when no host-assigned persisted/live identity is present. */
export function messageFallbackCorrelation(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.timestamp == null) return null;
  const toolCall =
    typeof record.toolCallId === "string" ? `:${record.toolCallId}` : "";
  return `${String(record.role ?? "")}:${String(record.timestamp)}${toolCall}`;
}

/** Persisted identity wins over live identity, which wins over correlation. */
export function structuralMessageIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.__inspireMessageId === "string")
    return `persisted:${record.__inspireMessageId}`;
  if (typeof record.__inspireLiveId === "string")
    return `live:${record.__inspireLiveId}`;
  return messageFallbackCorrelation(value);
}
