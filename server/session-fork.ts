import { chmod, link, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { piInstallation, SessionManager } from "./pi-runtime.js";
import { createPiSessionDirectoryResolver } from "./pi-session-directory.js";
import { requestError } from "./request-error.js";
import { runSessionDocumentWorker } from "./session-document-worker.js";
import type {
  ForkWorkerInput,
  ForkWorkerReply,
} from "./session-fork-worker.js";

export type StageSessionForkRequest = {
  sourcePath: string;
  sourceSessionId: string;
  sourceCommittedBytes: number;
  sourceFingerprint: string;
  sourceIdentity?: string;
} & (
  | {
      mode?: "fork" | "clone";
      targetId: string | null;
      targetParentId: string | null;
    }
  | { mode: "recover"; destinationCwd: string }
);

export interface StagedSessionFork {
  stagingDir: string;
  stagedPath: string;
  destinationPath: string;
  destinationId: string;
  sessionName?: string;
  destinationLeafId: string | null;
}

export type StageSessionFork = (
  request: StageSessionForkRequest,
) => Promise<StagedSessionFork>;

export const stageSessionFork: StageSessionFork = async (request) => {
  const sourcePath = resolve(request.sourcePath);
  const directory =
    request.mode === "recover"
      ? SessionManager.create(
          request.destinationCwd,
          await createPiSessionDirectoryResolver()(request.destinationCwd),
        ).getSessionDir()
      : dirname(sourcePath);
  const stagingDir = await mkdtemp(join(directory, ".inspire-fork-"));
  try {
    await chmod(stagingDir, 0o700);
    const data: ForkWorkerInput = {
      ...request,
      sourcePath,
      stagingDir,
      sdkEntryPath: piInstallation.sdkEntryPath,
    };
    const staged = await runSessionDocumentWorker<ForkWorkerReply>(
      "fork",
      data,
      {
        timeoutMs: 120_000,
        timeoutMessage: "Session fork worker timed out",
      },
    );
    if ("error" in staged) throw requestError(staged.error, staged.status);
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
