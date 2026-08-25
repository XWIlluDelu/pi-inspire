import {
  collectSessionResourceReferences,
  RESOURCE_LIST_INITIAL_SIZE,
  type SessionResourceReference,
} from "../shared/resource-references";

export interface ResourceRow extends SessionResourceReference {
  /** Basename used for display. */
  name: string;
}

/** Default bound for consumers that need a small recent resource sample. */
export const MAX_RESOURCE_ROWS = RESOURCE_LIST_INITIAL_SIZE;

/** Derive the deduplicated, recent-first resource list for the visible
 * session's messages. Extraction rules live in the shared pure module; this
 * only adds presentation metadata. */
export function resourceRows(
  references: readonly SessionResourceReference[],
): ResourceRow[] {
  return references.map((reference) => {
    const displayReference = reference.label
      .replace(/[?#].*$/u, "")
      .replace(/:\d+(?::\d+)?$/, "");
    const rawBasename =
      displayReference.split(/[\\/]/).pop() || displayReference;
    let basename = rawBasename;
    try {
      basename = decodeURIComponent(rawBasename);
    } catch {
      // Keep the literal reference when it contains malformed URL escapes.
    }
    return {
      ...reference,
      name: reference.source === "embedded" ? reference.label : basename,
    };
  });
}

export function collectResources(
  messages: readonly unknown[],
  limit?: number,
): ResourceRow[] {
  return resourceRows(collectSessionResourceReferences(messages, limit));
}

/** Merge a current-page projection ahead of the server's complete baseline.
 * Keys are extractor-owned stable identities; recent rows win so live tool
 * metadata is never replaced by an older snapshot. */
export function mergeResourceRows(
  recent: readonly ResourceRow[],
  baseline: readonly ResourceRow[],
): ResourceRow[] {
  const seen = new Set<string>();
  return [...recent, ...baseline].filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}
