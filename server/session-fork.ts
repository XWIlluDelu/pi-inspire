import { chmod, link, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { piInstallation } from "./pi-runtime.js";
import { requestError } from "./request-error.js";
import type {
  ForkWorkerInput,
  ForkWorkerReply,
} from "./session-fork-worker.js";

const FORK_WORKER_TIMEOUT_MS = 120_000;

export interface StageSessionForkRequest {
  sourcePath: string;
  sourceSessionId: string;
  sourceCommittedBytes: number;
  sourceFingerprint: string;
  sourceIdentity?: string;
  targetId: string | null;
  targetParentId: string | null;
  mode?: "fork" | "clone";
}

export interface StagedSessionFork {
  stagingDir: string;
  stagedPath: string;
  destinationPath: string;
  destinationId: string;
  cwd: string;
  parentSessionPath: string;
  sessionName?: string;
  destinationLeafId: string | null;
}

export type StageSessionFork = (
  request: StageSessionForkRequest,
) => Promise<StagedSessionFork>;

function copyInWorker(
  input: ForkWorkerInput,
): Promise<Omit<StagedSessionFork, "destinationPath">> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(
    `./session-fork-worker.${source ? "ts" : "js"}`,
    import.meta.url,
  );
  const bootstrap = source
    ? `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`
    : `await import(${JSON.stringify(entry.href)});`;
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    { workerData: input },
  );
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate();
    }, FORK_WORKER_TIMEOUT_MS);
    worker.once("message", (reply: ForkWorkerReply) => {
      clearTimeout(timer);
      if (timedOut) return;
      if ("error" in reply) reject(requestError(reply.error, reply.status));
      else resolve(reply);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`Session fork worker exited without a result (${code})`),
      );
    });
  });
}

export const stageSessionFork: StageSessionFork = async (request) => {
  const sourcePath = resolve(request.sourcePath);
  const directory = dirname(sourcePath);
  const stagingDir = await mkdtemp(join(directory, ".inspire-fork-"));
  try {
    await chmod(stagingDir, 0o700);
    const staged = await copyInWorker({
      ...request,
      sourcePath,
      stagingDir,
      sdkEntryPath: piInstallation.sdkEntryPath,
    });
    return {
      ...staged,
      destinationPath: join(directory, basename(staged.stagedPath)),
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
};

/** Same-directory hard-link publication is a no-replace atomic visibility
 * boundary: the catalog can observe either no destination or the complete
 * staged inode, never a partially copied JSONL file. */
export async function publishStagedSessionFork(
  fork: StagedSessionFork,
): Promise<void> {
  try {
    await link(fork.stagedPath, fork.destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw requestError("The fork destination already exists", 409);
    }
    throw error;
  }
  // Publication is committed once link() succeeds. Cleanup can never turn that
  // known durable result into a retryable failure.
  await rm(fork.stagingDir, { recursive: true, force: true }).catch((error) =>
    console.error("[inspire] Failed to remove Session fork staging:", error),
  );
}

export async function discardStagedSessionFork(
  fork: StagedSessionFork,
): Promise<void> {
  await rm(fork.stagingDir, { recursive: true, force: true });
}
