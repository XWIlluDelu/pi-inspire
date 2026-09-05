/** Read only from authoritative, unbounded branch messages, never a UI page. */
export function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (
      message.role !== "assistant" ||
      (typeof message.__inspireLiveId === "string" &&
        message.__inspireSettled !== true)
    )
      continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((part: Record<string, unknown>) =>
                part?.type === "text" && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : "";
    if (text.trim()) return text;
  }
  return null;
}
