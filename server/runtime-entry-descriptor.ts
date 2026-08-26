import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Stable, bounded diagnostic metadata for a persisted Pi session entry. */
export function describeSessionEntry(
  entry: SessionEntry,
): Record<string, unknown> {
  const encoded = JSON.stringify(entry);
  return {
    entryType: entry.type,
    entryId: entry.id,
    parentId: entry.parentId,
    entryBytes: Buffer.byteLength(encoded),
    entryHash: createHash("sha256").update(encoded).digest("base64url"),
  };
}
