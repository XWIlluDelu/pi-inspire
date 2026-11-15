import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalPersistedJson } from "./persisted-json.js";

/** Hash native JSON values rather than file whitespace or key order. */
export function nativeEntryDigest(entries: readonly SessionEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries)
    hash.update(canonicalPersistedJson(entry)).update("\n");
  return hash.digest("hex");
}
