import type { SessionCatalogIssue } from "../shared/contracts.js";
import { runSessionDocumentWorker } from "./session-document-worker.js";
import type { SessionRecord } from "./session-metadata.js";

/** Full-body parsing and fuzzy/regex work must not monopolize the Host. */
export async function searchSessionRecords(
  sessions: readonly SessionRecord[],
  query: string,
  signal?: AbortSignal,
  issues?: SessionCatalogIssue[],
  /** Receives a bounded body excerpt for matches with a contiguous hit. */
  snippets?: Map<string, string>,
): Promise<SessionRecord[]> {
  const result = await runSessionDocumentWorker<{
    ids: string[];
    issues: SessionCatalogIssue[];
    snippets?: Record<string, string>;
  }>(
    "search",
    { sessions, query, partial: Boolean(issues) },
    {
      signal,
      timeoutMs: 30_000,
      timeoutMessage: "Session search exceeded 30 seconds; simplify the query",
    },
  );
  signal?.throwIfAborted();
  issues?.push(...result.issues);
  for (const [id, snippet] of Object.entries(result.snippets ?? {}))
    snippets?.set(id, snippet);
  const matched = new Set(result.ids);
  return sessions.filter((session) => matched.has(session.id));
}
