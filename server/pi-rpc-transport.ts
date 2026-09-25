import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
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
}

export type PiRpcTransportFactory = (launch: PiRpcLaunch) => PiRpcTransport;

class DirectPiRpcTransport extends EventEmitter implements PiRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready = Promise.resolve();

  constructor(launch: PiRpcLaunch) {
    super();
    this.child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      ...isolatedProcessOptions(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.emit("error", error));
    this.child.once("exit", (code, signal) => this.emit("exit", code, signal));
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
}

export const createDirectPiRpcTransport: PiRpcTransportFactory = (launch) =>
  new DirectPiRpcTransport(launch);
