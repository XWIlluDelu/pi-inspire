import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Hash native JSON values rather than file whitespace or key order. */
export function nativeEntryDigest(entries: readonly SessionEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries)
    hash
      .update(
        JSON.stringify(entry, (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
        ),
      )
      .update("\n");
  return hash.digest("hex");
}
