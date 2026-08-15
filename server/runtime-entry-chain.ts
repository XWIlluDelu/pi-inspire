import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface RpcEntryChain {
  entries: SessionEntry[];
  leafId: string | null;
}

export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Parse and bound Pi's append-only entry chain before it joins runtime state. */
export function parseRpcEntryChain(
  value: unknown,
  options: {
    expectedParentId: string | null;
    maxEntries: number;
    maxBytes: number;
    label: string;
  },
): RpcEntryChain {
  const invalid = (detail: string): Error =>
    new Error(`Pi reported ${detail} ${options.label} entries`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("invalid");
  if (Buffer.byteLength(JSON.stringify(value)) > options.maxBytes)
    throw invalid("oversized");
  const response = value as Record<string, unknown>;
  if (
    !Array.isArray(response.entries) ||
    response.entries.length > options.maxEntries
  )
    throw invalid("invalid");
  const entries: SessionEntry[] = [];
  let expectedParentId = options.expectedParentId;
  for (const value of response.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalid("invalid");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.type !== "string" ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > 200 ||
      entry.parentId !== expectedParentId ||
      !isCanonicalIsoTimestamp(entry.timestamp)
    )
      throw invalid("non-contiguous");
    entries.push(entry as unknown as SessionEntry);
    expectedParentId = entry.id;
  }
  if (response.leafId !== expectedParentId) throw invalid("inconsistent");
  return { entries, leafId: expectedParentId };
}
