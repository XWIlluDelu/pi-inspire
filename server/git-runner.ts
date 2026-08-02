import { spawn } from "node:child_process";

export const GIT_TIMEOUT_MS = 4_000;
export const GIT_STDERR_BYTES = 64 * 1024;
export const GIT_CONFIG_ARGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=",
  "-c", "core.askPass=",
  "-c", "diff.external=",
] as const;

export interface GitRunOptions {
  stdoutLimit: number;
  allowStdoutTruncation?: boolean;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  stderrLimit?: number;
}
export interface GitRunResult { stdout: Buffer; stderr: Buffer; truncated: boolean; code: number }
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>;

export class GitInspectionError extends Error {
  status: number;
  detail?: string;
  exitCode?: number;
  constructor(message: string, status = 502, detail?: string, exitCode?: number) {
    super(message); this.name = "GitInspectionError"; this.status = status; this.detail = detail; this.exitCode = exitCode;
  }
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
}

export const spawnGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new GitInspectionError("Git inspection was cancelled", 499)); return; }
  const isolatedGroup = process.platform === "linux";
  const child = spawn("git", [...args], { shell: false, detached: isolatedGroup, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: gitEnvironment() });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let stdoutBytes = 0; let stderrBytes = 0; let truncated = false; let timedOut = false; let aborted = false; let outputFailed = false; let settled = false;
  const stderrLimit = options.stderrLimit ?? GIT_STDERR_BYTES;
  const kill = () => {
    if (isolatedGroup && child.pid) { try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* raced exit */ } }
    try { child.kill("SIGKILL"); } catch { /* close/error settles */ }
  };
  const onAbort = () => { aborted = true; kill(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? GIT_TIMEOUT_MS);
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); };
  child.stdout.on("data", (value: Buffer) => {
    const room = options.stdoutLimit - stdoutBytes;
    if (value.length > room) { if (room > 0) stdout.push(value.subarray(0, room)); stdoutBytes += Math.max(0, room); truncated = true; if (!options.allowStdoutTruncation) outputFailed = true; kill(); }
    else { stdout.push(value); stdoutBytes += value.length; }
  });
  child.stderr.on("data", (value: Buffer) => {
    const room = stderrLimit - stderrBytes; if (room > 0) stderr.push(value.subarray(0, room)); stderrBytes += value.length;
    if (stderrBytes > stderrLimit) { outputFailed = true; kill(); }
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (settled) return; settled = true; cleanup();
    reject(new GitInspectionError(error.code === "ENOENT" ? "Git is not available on this host" : "Git could not be started", error.code === "ENOENT" ? 503 : 502, error.message));
  });
  child.once("close", (code, signal) => {
    if (settled) return; settled = true; cleanup(); const stderrBuffer = Buffer.concat(stderr);
    if (aborted) { reject(new GitInspectionError("Git inspection was cancelled", 499)); return; }
    if (timedOut) { reject(new GitInspectionError("Git inspection timed out", 503, stderrBuffer.toString("utf8"))); return; }
    if (outputFailed) { reject(new GitInspectionError("Git inspection output exceeded its safety limit", 502, stderrBuffer.toString("utf8"))); return; }
    const numericCode = code ?? -1;
    if (!(truncated && options.allowStdoutTruncation) && !(options.acceptedExitCodes ?? [0]).includes(numericCode)) {
      reject(new GitInspectionError(signal ? "Git inspection was terminated" : "Git inspection failed", 502, stderrBuffer.toString("utf8"), numericCode)); return;
    }
    resolve({ stdout: Buffer.concat(stdout), stderr: stderrBuffer, truncated, code: numericCode });
  });
});
