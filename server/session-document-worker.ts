import { Worker } from "node:worker_threads";

/** Saved-document workers do bounded CPU and filesystem work without owning a
 * runtime. Join their retirement before the caller can discard their files. */
export async function runSessionDocumentWorker<Result>(
  task: "search" | "fork",
  data: unknown,
  options: { signal?: AbortSignal; timeoutMs: number; timeoutMessage: string },
): Promise<Result> {
  const { signal, timeoutMs, timeoutMessage } = options;
  signal?.throwIfAborted();
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(
    `./session-${task}-worker.${source ? "ts" : "js"}`,
    import.meta.url,
  );
  const worker = new Worker(
    source
      ? new URL(
          `data:text/javascript,${encodeURIComponent(
            `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`,
          )}`,
        )
      : entry,
    // The worker loads its own entry and loader, regardless of the Host's
    // CLI flags (for example --input-type when used from a script).
    { workerData: data, execArgv: [] },
  );
  const { promise, resolve, reject } = Promise.withResolvers<Result>();
  const cancel = () => reject(signal!.reason);
  const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  worker.once("message", resolve);
  worker.once("error", reject);
  worker.once("exit", (code) =>
    reject(
      new Error(`Session ${task} worker exited without a result (${code})`),
    ),
  );
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}
