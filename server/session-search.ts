import { runSessionDocumentWorker } from "./session-document-worker.js";
import type { SessionRecord } from "./session-metadata.js";

export interface SessionSearchResult {
  /** Every matching ID, with a body excerpt when its text matched contiguously. */
  hits: Map<string, string | undefined>;
  complete: boolean;
}

/** Full-body parsing and fuzzy/regex work must not monopolize the Host. */
export function searchSessionRecords(
  sessions: readonly SessionRecord[],
  query: string,
  signal?: AbortSignal,
) {
  return runSessionDocumentWorker<SessionSearchResult>(
    "search",
    { sessions, query },
    {
      signal,
      timeoutMs: 30_000,
      timeoutMessage: "Session search exceeded 30 seconds; simplify the query",
    },
  );
}
