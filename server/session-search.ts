import { Worker } from "node:worker_threads";
import type { SessionCatalogIssue } from "../shared/contracts.js";
import type { SessionRecord } from "./session-metadata.js";

/** Full-body parsing and fuzzy/regex work must not monopolize the Host. */
export function searchSessionRecords(
  sessions: readonly SessionRecord[],
  query: string,
  signal?: AbortSignal,
  issues?: SessionCatalogIssue[],
): Promise<SessionRecord[]> {
  signal?.throwIfAborted();
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(
    `./session-search-worker.${source ? "ts" : "js"}`,
    import.meta.url,
  );
  const bootstrap = source
    ? `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`
    : `await import(${JSON.stringify(entry.href)});`;
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    {
      workerData: {
        sessions,
        query,
        partial: Boolean(issues),
      },
    },
  );
  return new Promise((resolve, reject) => {
    const cancel = () =>
      finish(signal?.reason ?? new Error("Session search cancelled"));
    // A pathological regex is terminable even while matching is synchronous.
    const timer = setTimeout(
      () =>
        finish(
          new Error("Session search exceeded 30 seconds; simplify the query"),
        ),
      30_000,
    );
    const finish = (error?: unknown, ids?: string[]) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else {
        const matched = new Set(ids);
        resolve(sessions.filter((session) => matched.has(session.id)));
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once(
      "message",
      (result: { ids: string[]; issues: SessionCatalogIssue[] }) => {
        issues?.push(...result.issues);
        finish(undefined, result.ids);
      },
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) =>
      finish(
        new Error(`Session search worker exited without a result (${code})`),
      ),
    );
  });
}
