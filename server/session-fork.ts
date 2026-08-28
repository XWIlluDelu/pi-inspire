import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, link, lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SESSION_ID_CHARS } from "../shared/contracts.js";
import { piInstallation } from "./pi-runtime.js";
import { isolatedProcessOptions, signalProcessTree } from "./process-tree.mjs";
import type {
  SessionForkWorkerRequest,
  SessionForkWorkerResult,
} from "./session-fork-worker.js";

const MAX_WORKER_OUTPUT_BYTES = 256 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
const FORK_WORKER_TIMEOUT_MS = 120_000;

export interface StageSessionForkRequest {
  sourcePath: string;
  sourceSessionId: string;
  sourceCommittedBytes: number;
  sourceFingerprint: string;
  targetId: string;
  targetParentId: string | null;
}

export interface StagedSessionFork {
  stagingDir: string;
  stagedPath: string;
  destinationPath: string;
  destinationId: string;
  cwd: string;
  parentSessionPath: string;
  sessionName?: string;
}

export type StageSessionFork = (
  request: StageSessionForkRequest,
) => Promise<StagedSessionFork>;

class SessionForkError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionForkError";
  }
}

function workerPath(): string {
  const ownPath = fileURLToPath(import.meta.url);
  return join(
    dirname(ownPath),
    `session-fork-worker.${ownPath.endsWith(".ts") ? "ts" : "js"}`,
  );
}

function workerArguments(path: string): string[] {
  if (!path.endsWith(".ts")) return [path];
  return ["--import", import.meta.resolve("tsx"), path];
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workerError(code: unknown): SessionForkError {
  switch (code) {
    case "SOURCE_CHANGED":
      return new SessionForkError(
        "The source Session changed before its fork boundary could be verified",
        409,
      );
    case "SOURCE_ID_MISMATCH":
      return new SessionForkError("The source Session identity changed", 409);
    case "SOURCE_FORMAT":
      return new SessionForkError(
        "The source Session must be opened with the current Pi version before it can be forked",
        409,
      );
    case "TARGET_INVALID":
      return new SessionForkError(
        "The selected fork point is no longer available",
        409,
      );
    default:
      return new SessionForkError(
        "The isolated Session fork worker failed",
        500,
      );
  }
}

async function stopWorker(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await signalProcessTree(child, "SIGTERM", { isolated: true }).catch(
    () => undefined,
  );
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    await signalProcessTree(child, "SIGKILL", { isolated: true }).catch(
      () => undefined,
    );
  }
}

async function invokeWorker(
  request: SessionForkWorkerRequest,
): Promise<SessionForkWorkerResult> {
  const path = workerPath();
  const child = spawn(process.execPath, workerArguments(path), {
    cwd: dirname(request.sourcePath),
    env: {
      ...process.env,
      INSPIRE_PI_COMMAND: piInstallation.commandPath,
      PI_SKIP_VERSION_CHECK: "1",
    },
    ...isolatedProcessOptions(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let outputExceeded = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
      outputExceeded = true;
      void stopWorker(child);
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(
      -MAX_WORKER_STDERR_BYTES,
    );
  });

  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(request));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopWorker(child);
  }, FORK_WORKER_TIMEOUT_MS);
  let exit: Awaited<typeof completion>;
  try {
    exit = await completion;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    throw new SessionForkError(
      "The isolated Session fork worker timed out",
      504,
    );
  }
  if (outputExceeded) {
    throw new SessionForkError(
      "The isolated Session fork worker returned too much data",
      500,
    );
  }

  let envelope: Record<string, unknown> | null = null;
  try {
    envelope = responseRecord(
      JSON.parse(Buffer.concat(stdout).toString("utf8").trim()),
    );
  } catch {
    // The bounded stderr is intentionally retained only in Host diagnostics.
  }
  if (!envelope || envelope.ok !== true) {
    const error = responseRecord(envelope?.error);
    if (stderr) console.error("[inspire] Session fork worker:", stderr.trim());
    throw workerError(error?.code);
  }
  if (exit.code !== 0 || exit.signal !== null) {
    throw new SessionForkError(
      "The isolated Session fork worker exited unexpectedly",
      500,
    );
  }
  const result = responseRecord(envelope.result);
  if (
    !result ||
    typeof result.destinationId !== "string" ||
    result.destinationId.length === 0 ||
    result.destinationId.length > MAX_SESSION_ID_CHARS ||
    typeof result.stagedPath !== "string" ||
    typeof result.cwd !== "string" ||
    typeof result.parentSessionPath !== "string" ||
    (result.sessionName !== undefined && typeof result.sessionName !== "string")
  ) {
    throw new SessionForkError(
      "The isolated Session fork worker returned invalid data",
      500,
    );
  }
  return result as unknown as SessionForkWorkerResult;
}

export const stageSessionFork: StageSessionFork = async (
  request,
): Promise<StagedSessionFork> => {
  const sourcePath = resolve(request.sourcePath);
  const sourceDirectory = dirname(sourcePath);
  const stagingDir = await mkdtemp(join(sourceDirectory, ".inspire-fork-"));
  await chmod(stagingDir, 0o700);
  try {
    const result = await invokeWorker({
      ...request,
      sourcePath,
      stagingDir,
    });
    const stagedPath = resolve(result.stagedPath);
    if (
      dirname(stagedPath) !== stagingDir ||
      basename(stagedPath) !== basename(result.stagedPath) ||
      !basename(stagedPath).endsWith(".jsonl") ||
      resolve(result.parentSessionPath) !== sourcePath
    ) {
      throw new SessionForkError(
        "The isolated Session fork worker returned an unsafe destination",
        500,
      );
    }
    const stagedIdentity = await lstat(stagedPath);
    if (!stagedIdentity.isFile() || stagedIdentity.isSymbolicLink()) {
      throw new SessionForkError(
        "The isolated Session fork worker returned an invalid destination",
        500,
      );
    }
    const destinationPath = join(sourceDirectory, basename(stagedPath));
    if (resolve(destinationPath) === sourcePath) {
      throw new SessionForkError(
        "The isolated Session fork worker reused the source path",
        500,
      );
    }
    return {
      stagingDir,
      stagedPath,
      destinationPath,
      destinationId: result.destinationId,
      cwd: result.cwd,
      parentSessionPath: sourcePath,
      sessionName: result.sessionName,
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
      throw new SessionForkError("The fork destination already exists", 409);
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
