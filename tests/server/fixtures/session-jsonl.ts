export function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function messageEntry<T extends { timestamp: number }>(
  id: string,
  parentId: string | null,
  message: T,
  timestamp = new Date(message.timestamp).toISOString(),
) {
  return { type: "message" as const, id, parentId, timestamp, message };
}
