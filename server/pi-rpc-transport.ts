import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { stopPiRpcChild } from "./pi-rpc-stop.js";
import { isolatedProcessOptions } from "./process-tree.mjs";

export interface PiRpcLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type PiRpcStopDiagnostic = (
  event: string,
  fields: Record<string, unknown>,
) => void;

/** Process placement supplies bytes and a real writer-stop fence. It never
 * interprets RPC commands or owns session operations. A closed transport is
 * not proof of process exit: only successful stop() releases writer authority.
 */
export interface PiRpcTransport extends EventEmitter {
  readonly pid: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly available: boolean;
  readonly ready: Promise<void>;
  stop(graceful: boolean, diagnostic: PiRpcStopDiagnostic): Promise<void>;
  /** Let Pi outlive this Host with its work running; the transport is then
   * closed without stopping Pi. */
  detach?(): Promise<void>;
}

export type PiRpcTransportFactory = (launch: PiRpcLaunch) => PiRpcTransport;

const KEEPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "pi-worker-keeper.mjs",
);

/** Under a systemd service, a Host restart ends its whole cgroup. A worker
 * that may be preserved therefore starts in a transient scope of its own. */
function keeperCommand(launch: PiRpcLaunch): {
  command: string;
  args: string[];
} {
  const keeper = [KEEPER, launch.executable, ...launch.args];
  if (process.platform === "linux" && process.env.INVOCATION_ID)
    return {
      command: "systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        process.execPath,
        ...keeper,
      ],
    };
  return { command: process.execPath, args: keeper };
}

class DirectPiRpcTransport extends EventEmitter implements PiRpcTransport {
  private readonly child: ChildProcess & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
  };
  private readonly control: Writable;
  readonly ready = Promise.resolve();

  constructor(launch: PiRpcLaunch) {
    super();
    const { command, args } = keeperCommand(launch);
    this.child = spawn(command, args, {
      cwd: launch.cwd,
      env: launch.env,
      ...isolatedProcessOptions(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as DirectPiRpcTransport["child"];
    this.child.on("error", (error) => this.emit("error", error));
    this.child.once("exit", (code, signal) => this.emit("exit", code, signal));
    this.control = this.child.stdio[3] as Writable;
    this.control.on("error", () => {});
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get stdin(): Writable {
    return this.child.stdin;
  }

  get stdout(): Readable {
    return this.child.stdout;
  }

  get stderr(): Readable {
    return this.child.stderr;
  }

  get available(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  stop(graceful: boolean, diagnostic: PiRpcStopDiagnostic): Promise<void> {
    return stopPiRpcChild(this.child, graceful, diagnostic);
  }

  async detach(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.control.end("detach\n", () => resolve()),
    );
    this.child.unref();
  }
}

export const createDirectPiRpcTransport: PiRpcTransportFactory = (launch) =>
  new DirectPiRpcTransport(launch);
