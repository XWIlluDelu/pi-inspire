import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";
import { MAX_RPC_OUTBOUND_LINE_BYTES } from "../shared/contracts.js";
import type { DiagnosticLevel } from "./diagnostics.js";
import { piInstallation } from "./pi-runtime.js";

export { MAX_RPC_OUTBOUND_LINE_BYTES } from "../shared/contracts.js";

export interface PiRpcResponseFence {
  received: boolean;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
  written: boolean;
  mayMutate: boolean;
  responseFence?: PiRpcResponseFence;
}

export class PiRpcOutcomeUnknownError extends Error {
  readonly code = "PI_RPC_OUTCOME_UNKNOWN";
  readonly outcomeUnknown = true;
  stopped: Promise<void> = Promise.resolve();

  constructor(
    readonly command: string,
    message = `Pi command ${command} outcome is unknown`,
  ) {
    super(message);
    this.name = "PiRpcOutcomeUnknownError";
  }
}

export function isPiRpcOutcomeUnknown(
  error: unknown,
): error is PiRpcOutcomeUnknownError {
  return (
    error instanceof PiRpcOutcomeUnknownError ||
    Boolean(
      error &&
        typeof error === "object" &&
        (error as { outcomeUnknown?: unknown }).outcomeUnknown === true,
    )
  );
}

interface RpcResponse {
  type: "response";
  id?: string;
  success: boolean;
  command: string;
  data?: unknown;
  error?: string;
}

/** Pi may echo an accepted prompt as a message/entry event with a slightly
 * larger envelope than the stdin command. Keep both directions tied to the
 * same payload authority while retaining a hard host-memory boundary. */
export const MAX_RPC_LINE_BYTES = MAX_RPC_OUTBOUND_LINE_BYTES + 1024 * 1024;

const READ_ONLY_RPC_COMMANDS = new Set([
  "get_available_models",
  "get_commands",
  "get_entries",
  "get_messages",
  "get_pending_message_texts",
  "get_session_stats",
  "get_state",
]);

function encodeOutboundFrame(value: Record<string, unknown>): string {
  const frame = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(frame);
  if (bytes > MAX_RPC_OUTBOUND_LINE_BYTES) {
    throw Object.assign(
      new Error(
        `Pi RPC stdin line exceeded ${MAX_RPC_OUTBOUND_LINE_BYTES} bytes`,
      ),
      { status: 413 },
    );
  }
  return frame;
}

export interface PiRpcOptions {
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  workerId?: string;
  diagnostic?: (
    level: DiagnosticLevel,
    event: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export class PiRpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private stderr = "";
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: PiRpcOptions) {
    super();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get available(): boolean {
    return Boolean(
      this.child && this.child.exitCode === null && this.child.stdin.writable,
    );
  }

  private diagnostic(
    level: DiagnosticLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.options.diagnostic?.(level, event, {
      workerId: this.options.workerId,
      childPid: this.pid,
      ...fields,
    });
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Pi RPC process is already running");

    const cliPath = this.options.cliPath ?? piInstallation.cliPath;
    const child = spawn(
      process.execPath,
      [cliPath, "--mode", "rpc", ...(this.options.args ?? [])],
      {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          PI_SKIP_VERSION_CHECK: "1",
          ...this.options.env,
        },
        // Pi and every tool it launches own an isolated process group on
        // POSIX. Host eviction can then terminate the whole worker tree rather
        // than orphaning a long-running shell/tool grandchild.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.stopping = false;
    this.stopPromise = null;
    this.diagnostic("info", "worker_spawn", { childPid: child.pid });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-65_536);
    });
    child.stderr.on("error", (error) => this.handleExit(child, error));
    child.stdout.on("error", (error) => this.handleExit(child, error));
    child.stdin.on("error", (error) => this.handleExit(child, error));
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      // The group can outlive its leader when a tool ignores SIGTERM. Once Pi
      // is gone there is no owner left for such descendants, so reap them.
      if (process.platform !== "win32") this.signalWorkerTree(child, "SIGKILL");
      if (this.stopping) return;
      this.handleExit(
        child,
        new Error(`Pi RPC exited (code=${code}, signal=${signal})`),
      );
    });

    this.attachLineReader(child);
    await this.request({ type: "get_state" }, 60_000);
  }

  private signalWorkerTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    child.kill(signal);
  }

  private attachLineReader(child: ChildProcessWithoutNullStreams): void {
    let decoder = new TextDecoder("utf-8", { fatal: true });
    let parts: string[] = [];
    let lineBytes = 0;
    let failed = false;

    const failProtocol = (error: Error) => {
      if (failed) return;
      failed = true;
      parts = [];
      this.handleExit(child, error);
    };
    const failOversizedLine = () =>
      failProtocol(
        new Error(`Pi RPC stdout line exceeded ${MAX_RPC_LINE_BYTES} bytes`),
      );

    const append = (part: Buffer): boolean => {
      lineBytes += part.length;
      if (lineBytes > MAX_RPC_LINE_BYTES) {
        failOversizedLine();
        return false;
      }
      try {
        const decoded = decoder.decode(part, { stream: true });
        if (decoded) parts.push(decoded);
        return true;
      } catch {
        failProtocol(new Error("Pi RPC stdout was not valid UTF-8"));
        return false;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!append(chunk.subarray(start, end))) return;
        if (newline < 0) return;

        let tail: string;
        try {
          tail = decoder.decode();
        } catch {
          failProtocol(new Error("Pi RPC stdout was not valid UTF-8"));
          return;
        }
        if (tail) parts.push(tail);
        let line = parts.join("");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        parts = [];
        lineBytes = 0;
        decoder = new TextDecoder("utf-8", { fatal: true });
        if (!this.handleLine(line)) {
          failProtocol(new Error("Pi RPC stdout contained a malformed frame"));
          return;
        }
        start = newline + 1;
      }
    });

    child.stdout.on("end", () => {
      if (failed) return;
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        failProtocol(new Error("Pi RPC stdout was not valid UTF-8"));
        return;
      }
      if (tail) parts.push(tail);
      if (parts.length > 0) {
        let line = parts.join("");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!this.handleLine(line)) {
          failProtocol(new Error("Pi RPC stdout contained a malformed frame"));
          return;
        }
      }
      if (this.child === child && !this.stopping) {
        failProtocol(new Error("Pi RPC stdout closed unexpectedly"));
      }
    });
  }

  private handleLine(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;

    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string") return false;
    if (record.type === "response") {
      if (
        typeof record.id !== "string" ||
        typeof record.command !== "string" ||
        typeof record.success !== "boolean"
      )
        return false;
      const pending = this.pending.get(record.id);
      if (!pending || record.command !== pending.command) return false;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      this.diagnostic(record.success ? "debug" : "warning", "rpc_response", {
        requestId: record.id,
        command: pending.command,
        success: record.success,
      });
      // Flip the fence while consuming the response line, before another
      // frame from the same stdout chunk can be dispatched. Session
      // replacement uses this exact wire boundary to attribute events.
      if (pending.responseFence) pending.responseFence.received = true;
      pending.resolve(record as unknown as RpcResponse);
      return true;
    }
    this.emit("event", value);
    return true;
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.child !== child) return;
    this.diagnostic("error", "worker_exit", {
      errorName: error.name,
      pendingRequests: this.pending.size,
      expected: this.stopping,
    });
    const stopped = this.terminateUnexpectedChild(child);
    this.stopPromise = stopped;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.written && pending.mayMutate) {
        const unknown = this.withStderr(
          new PiRpcOutcomeUnknownError(
            pending.command,
            `Pi command ${pending.command} outcome is unknown because the child exited`,
          ),
        ) as PiRpcOutcomeUnknownError;
        unknown.stopped = stopped;
        pending.reject(unknown);
      } else {
        pending.reject(this.withStderr(error));
      }
    }
    this.pending.clear();
    this.child = null;
    this.emit("exit", this.withStderr(error));
  }

  private terminateUnexpectedChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let hard: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (hard) clearTimeout(hard);
        resolve();
      };
      child.once("exit", finish);
      child.once("close", finish);
      child.once("error", finish);
      this.signalWorkerTree(child, "SIGKILL");
      if (child.exitCode !== null || child.signalCode !== null) finish();
      if (!settled) {
        hard = setTimeout(finish, 1_000);
        hard.unref?.();
      }
    });
  }

  /** Host-side diagnostics ride along as a `detail` property for the host
   * log. They never join `message` — that string reaches the browser through
   * runtime_error events and API error bodies, and raw stderr can carry
   * anything the child process printed, credentials included. */
  private withStderr(error: Error): Error {
    const detail = this.stderr.trim();
    return detail
      ? Object.assign(error, { detail: `Pi stderr: ${detail}` })
      : error;
  }

  async request<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
    responseFence?: PiRpcResponseFence,
  ): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error("Pi RPC process is not available");
    }

    const id = `inspire_${++this.requestSequence}`;
    const commandName = String(command.type);
    const frame = encodeOutboundFrame({ ...command, id });
    const mayMutate = !READ_ONLY_RPC_COMMANDS.has(commandName);
    this.diagnostic("debug", "rpc_request", {
      requestId: id,
      command: commandName,
    });
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        command: commandName,
        written: false,
        mayMutate,
        responseFence,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        this.diagnostic("error", "rpc_timeout", {
          requestId: id,
          command: commandName,
          written: pending.written,
          timeoutMs,
        });
        if (!pending.written) {
          reject(
            this.withStderr(
              new Error(`Timed out before writing Pi command ${commandName}`),
            ),
          );
          return;
        }
        if (!mayMutate) {
          const error = this.withStderr(
            new Error(`Pi command ${commandName} response timed out`),
          );
          void this.stopForProtocolFailure(error);
          reject(error);
          return;
        }
        const error = this.withStderr(
          new PiRpcOutcomeUnknownError(
            commandName,
            `Pi command ${commandName} outcome is unknown after its response timed out`,
          ),
        ) as PiRpcOutcomeUnknownError;
        error.stopped = this.stopForProtocolFailure(error);
        reject(error);
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        child.stdin.write(frame, (error) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (current !== pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          this.diagnostic("error", "rpc_write_failed", {
            requestId: id,
            command: commandName,
          });
          if (!mayMutate) {
            const failure = this.withStderr(
              new Error(`Pi command ${commandName} stdin write failed`),
            );
            void this.stopForProtocolFailure(failure);
            pending.reject(failure);
            return;
          }
          const unknown = this.withStderr(
            new PiRpcOutcomeUnknownError(
              commandName,
              `Pi command ${commandName} outcome is unknown after its stdin write failed`,
            ),
          ) as PiRpcOutcomeUnknownError;
          unknown.stopped = this.stopForProtocolFailure(unknown);
          pending.reject(unknown);
        });
        // A non-throwing write transfers the frame to Node's stream buffer;
        // from this point the host cannot prove the child did not accept it.
        pending.written = true;
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });

    if (!response.success)
      throw new Error(
        response.error ?? `Pi command ${response.command} failed`,
      );
    return response.data as T;
  }

  async sendExtensionUiResponse(
    response: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error("Pi RPC process is not available");
    }
    const frame = encodeOutboundFrame({
      type: "extension_ui_response",
      ...response,
    });
    const requestId = typeof response.id === "string" ? response.id : undefined;
    this.diagnostic("debug", "rpc_extension_response", {
      requestId,
      command: "extension_ui_response",
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const failUnknown = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const unknown = this.withStderr(
          new PiRpcOutcomeUnknownError("extension_ui_response", message),
        ) as PiRpcOutcomeUnknownError;
        unknown.stopped = this.stopForProtocolFailure(unknown);
        reject(unknown);
      };
      timer = setTimeout(() => {
        this.diagnostic("error", "rpc_extension_response_timeout", {
          requestId,
          command: "extension_ui_response",
          timeoutMs,
        });
        failUnknown(
          "Pi extension response outcome is unknown after its stdin write timed out",
        );
      }, timeoutMs);
      timer.unref?.();
      try {
        child.stdin.write(frame, (error) => {
          if (settled) return;
          if (error) {
            this.diagnostic("error", "rpc_extension_response_write_failed", {
              requestId,
              command: "extension_ui_response",
            });
            failUnknown(
              "Pi extension response outcome is unknown after its stdin write failed",
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** A request-level timeout/write failure stops the protocol stream. Notify
   * the owner after the child is gone: late frames can no longer be correlated,
   * so keeping the wrapper in a runtime slot would make later reads or writes
   * appear usable when they are not. Deliberate host shutdown still uses
   * `stop()` directly and does not emit an unexpected-exit event. */
  private stopForProtocolFailure(error: Error): Promise<void> {
    const stopped = this.stop();
    void stopped.then(() => this.emit("exit", error));
    return stopped;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return;
    this.diagnostic("info", "worker_stop_requested", {
      childPid: child.pid,
      pendingRequests: this.pending.size,
    });
    this.stopping = true;
    this.child = null;

    const stopped = new Promise<void>((resolve) => {
      let settled = false;
      let force: NodeJS.Timeout | undefined;
      let hard: NodeJS.Timeout | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (force) clearTimeout(force);
        if (hard) clearTimeout(hard);
        resolve();
      };
      child.once("exit", settle);
      child.once("close", settle);
      child.once("error", settle);
      if (child.exitCode !== null || child.signalCode !== null) {
        settle();
        return;
      }
      this.signalWorkerTree(child, "SIGTERM");
      force = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          settle();
          return;
        }
        this.signalWorkerTree(child, "SIGKILL");
        hard = setTimeout(settle, 1_000);
        hard.unref?.();
      }, 1_500);
      force.unref?.();
    });
    this.stopPromise = stopped;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.written && pending.mayMutate) {
        const error = new PiRpcOutcomeUnknownError(
          pending.command,
          `Pi command ${pending.command} outcome is unknown because the child was stopped before its response`,
        );
        error.stopped = stopped;
        pending.reject(error);
      } else {
        pending.reject(new Error("Pi RPC process stopped"));
      }
    }
    this.pending.clear();
    await stopped;
    this.diagnostic("info", "worker_stopped", { childPid: child.pid });
  }
}
