import { writeFile } from "node:fs/promises";

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

export const thinkingOff = {
  type: "thinking_level_change",
  id: "thinking",
  parentId: null,
  timestamp: "2026-08-01T00:00:00.000Z",
  thinkingLevel: "off",
};

export async function writeSession(
  path: string,
  cwd: string,
  id: string,
  entries: readonly unknown[],
) {
  const timestamp = "2026-08-01T00:00:00.000Z";
  await writeFile(
    path,
    jsonl(
      {
        type: "session",
        version: 3,
        id,
        cwd,
        timestamp,
      },
      ...entries,
    ),
  );
  return { id, path };
}
