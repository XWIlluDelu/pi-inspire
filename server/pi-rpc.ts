import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
  written: boolean;
}

export class PiRpcOutcomeUnknownError extends Error {
  readonly code = "PI_RPC_OUTCOME_UNKNOWN";
  readonly outcomeUnknown = true;
  stopped: Promise<void> = Promise.resolve();

  constructor(readonly command: string, message = `Pi command ${command} outcome is unknown`) {
    super(message);
    this.name = "PiRpcOutcomeUnknownError";
  }
}

export function isPiRpcOutcomeUnknown(error: unknown): error is PiRpcOutcomeUnknownError {
  return error instanceof PiRpcOutcomeUnknownError || Boolean(
    error && typeof error === "object" && (error as { outcomeUnknown?: unknown }).outcomeUnknown === true,
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

/** Pi RPC is JSONL. A malformed child must not retain an arbitrarily large
 * unterminated line in the long-lived host; ordinary Pi events are far below
 * this ceiling, while the browser projection is capped more tightly still. */
export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

export interface PiRpcOptions {
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
}

function resolvePiCliPath(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(entry), "cli.js");
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

  async start(): Promise<void> {
    if (this.child) throw new Error("Pi RPC process is already running");

    const cliPath = this.options.cliPath ?? resolvePiCliPath();
    const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: "1",
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;
    this.stopPromise = null;

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-65_536);
    });
    child.stdout.on("error", (error) => this.handleExit(child, error));
    child.stdin.on("error", (error) => this.handleExit(child, error));
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      if (this.stopping) return;
      this.handleExit(child, new Error(`Pi RPC exited (code=${code}, signal=${signal})`));
    });

    this.attachLineReader(child);
    await this.request({ type: "get_state" }, 60_000);
  }

  private attachLineReader(child: ChildProcessWithoutNullStreams): void {
    let decoder = new StringDecoder("utf8");
    let parts: string[] = [];
    let lineBytes = 0;
    let failed = false;

    const failOversizedLine = () => {
      if (failed) return;
      failed = true;
      parts = [];
      this.stopping = true; // suppress the duplicate process-exit notification
      this.handleExit(child, new Error(`Pi RPC stdout line exceeded ${MAX_RPC_LINE_BYTES} bytes`));
      child.kill("SIGKILL");
    };

    const append = (part: Buffer): boolean => {
      lineBytes += part.length;
      if (lineBytes > MAX_RPC_LINE_BYTES) {
        failOversizedLine();
        return false;
      }
      const decoded = decoder.write(part);
      if (decoded) parts.push(decoded);
      return true;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!append(chunk.subarray(start, end))) return;
        if (newline < 0) return;

        const tail = decoder.end();
        if (tail) parts.push(tail);
        let line = parts.join("");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        parts = [];
        lineBytes = 0;
        decoder = new StringDecoder("utf8");
        this.handleLine(line);
        start = newline + 1;
      }
    });

    child.stdout.on("end", () => {
      if (failed) return;
      const tail = decoder.end();
      if (tail) parts.push(tail);
      if (parts.length > 0) {
        let line = parts.join("");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    if (record.type === "response") {
      if (typeof record.id === "string") {
        const pending = this.pending.get(record.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(record.id);
          pending.resolve(record as unknown as RpcResponse);
        }
      }
      return;
    }
    this.emit("event", value);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.written
        ? this.withStderr(new PiRpcOutcomeUnknownError(pending.command, `Pi command ${pending.command} outcome is unknown because the child exited`))
        : this.withStderr(error));
    }
    this.pending.clear();
    this.child = null;
    this.emit("exit", this.withStderr(error));
  }

  /** Host-side diagnostics ride along as a `detail` property for the host
   * log. They never join `message` — that string reaches the browser through
   * runtime_error events and API error bodies, and raw stderr can carry
   * anything the child process printed, credentials included. */
  private withStderr(error: Error): Error {
    const detail = this.stderr.trim();
    return detail ? Object.assign(error, { detail: `Pi stderr: ${detail}` }) : error;
  }

  async request<T = unknown>(command: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error("Pi RPC process is not available");
    }

    const id = `inspire_${++this.requestSequence}`;
    const commandName = String(command.type);
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        command: commandName,
        written: false,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        if (!pending.written) {
          reject(this.withStderr(new Error(`Timed out before writing Pi command ${commandName}`)));
          return;
        }
        const error = this.withStderr(new PiRpcOutcomeUnknownError(
          commandName,
          `Pi command ${commandName} outcome is unknown after its response timed out`,
        )) as PiRpcOutcomeUnknownError;
        error.stopped = this.stopForUnknown(error);
        reject(error);
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (current !== pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          const unknown = this.withStderr(new PiRpcOutcomeUnknownError(
            commandName,
            `Pi command ${commandName} outcome is unknown after its stdin write failed`,
          )) as PiRpcOutcomeUnknownError;
          unknown.stopped = this.stopForUnknown(unknown);
          pending.reject(unknown);
        });
        // A non-throwing write transfers the frame to Node's stream buffer;
        // from this point the host cannot prove the child did not accept it.
        pending.written = true;
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (!response.success) throw new Error(response.error ?? `Pi command ${response.command} failed`);
    return response.data as T;
  }

  async sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error("Pi RPC process is not available");
    }
    await new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`, (error) => {
          if (!error) {
            resolve();
            return;
          }
          const unknown = this.withStderr(new PiRpcOutcomeUnknownError(
            "extension_ui_response",
            "Pi extension response outcome is unknown after its stdin write failed",
          )) as PiRpcOutcomeUnknownError;
          unknown.stopped = this.stopForUnknown(unknown);
          reject(unknown);
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** A request-level timeout/write failure stops the protocol stream. Notify
   * the owner after the child is gone: late frames can no longer be correlated,
   * so keeping the wrapper in a runtime slot would make later reads or writes
   * appear usable when they are not. Deliberate host shutdown still uses
   * `stop()` directly and does not emit an unexpected-exit event. */
  private stopForUnknown(error: PiRpcOutcomeUnknownError): Promise<void> {
    const stopped = this.stop();
    void stopped.then(() => this.emit("exit", error));
    return stopped;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;

    const stopped = new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 1_500);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.stopPromise = stopped;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new PiRpcOutcomeUnknownError(
        pending.command,
        `Pi command ${pending.command} outcome is unknown because the child was stopped before its response`,
      );
      error.stopped = stopped;
      pending.reject(pending.written ? error : new Error("Pi RPC process stopped"));
    }
    this.pending.clear();
    await stopped;
  }
}
