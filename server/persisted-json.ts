import { isDeepStrictEqual } from "node:util";

function persistedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : (JSON.parse(encoded) as unknown);
}

export function samePersistedJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(persistedJson(left), persistedJson(right));
}

/** Stable JSON bytes for receipts and native checkpoint evidence. */
export function canonicalPersistedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, record[key]]),
    );
  }) ?? "null";
}
