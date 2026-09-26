import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HERDR_BRIDGE_VERSION,
  herdrBridgeHelloSchema,
  herdrBridgeReadySchema,
  readHerdrBridgeRecord,
  writeHerdrBridgeRecord,
} from "./herdr-bridge-protocol.js";
import type { HerdrClient, HerdrWorkerPane } from "./herdr-client.js";
import {
  assertHerdrGroupMember,
  assertHerdrWorkerScopesAvailable,
  captureHerdrProcessGroup,
  type HerdrProcessGroup,
  stopHerdrProcessGroup,
} from "./herdr-process-group.js";
import type {
  HerdrWorkerLease,
  HerdrWorkerRegistry,
} from "./herdr-worker-registry.js";
import type {
  PiRpcLaunch,
  PiRpcStopDiagnostic,
  PiRpcTransport,
} from "./pi-rpc-transport.js";

interface HerdrRpcTransportOptions {
  client: Pick<HerdrClient, "createWorkerPane" | "closePane">;
  registry: HerdrWorkerRegistry;
  label: string;
  assertWritable?: () => Promise<void>;
  assertScopesAvailable?: () => Promise<void>;
}

function workerCommand(
  path: string,
  scopeName: string,
): { entry: string; argv: string[] } {
  const source = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(
    new URL(
      source ? "./herdr-worker-entry.ts" : "./herdr-worker-entry.js",
      import.meta.url,
    ),
  );
  // Use a loader in this process, not `tsx`'s CLI child. The actual bridge must
  // be the pane's process-group leader, so its group can be fenced before Pi
  // is allowed to exist.
  const loader = source
    ? [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      ]
    : [];
  return {
    entry,
    argv: [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${scopeName}`,
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=1500ms",
      "--",
      process.execPath,
      ...loader,
      entry,
      path,
    ],
  };
}

/** Two private sockets carry Pi's existing stdin/stdout and stderr bytes.
 * Framing is used only for authenticated startup; conversation traffic takes
 * the same PiRpcProcess parser and has no second JSON decoder or scheduler.
 */
export class HerdrRpcTransport extends EventEmitter implements PiRpcTransport {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly ready: Promise<void>;
  private workerPid: number | null = null;
  private connected = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly startup = new AbortController();
  private readonly token = randomBytes(32).toString("hex");
  private readonly scopeName = `inspire-pi-${randomUUID()}.scope`;
  private server: Server | null = null;
  private directory: string | null = null;
  private pane: HerdrWorkerPane | null = null;
  private lease: HerdrWorkerLease | null = null;
  private group: HerdrProcessGroup | null = null;
  private rpc: Socket | null = null;
  private errors: Socket | null = null;
  private bridgePid: number | null = null;
  private granting: Promise<void> | null = null;
  private readonly sockets = new Set<Socket>();
  private resolveHandshake!: () => void;
  private rejectHandshake!: (error: Error) => void;
  private readonly handshake = new Promise<void>((resolve, reject) => {
    this.resolveHandshake = resolve;
    this.rejectHandshake = reject;
  });

  constructor(
    private readonly launch: PiRpcLaunch,
    private readonly options: HerdrRpcTransportOptions,
  ) {
    super();
    // The bridge can connect before allocation returns. The ready promise
    // remains the caller's error boundary while its private lease is recorded.
    void this.handshake.catch(() => undefined);
    this.ready = Promise.resolve().then(() => this.start());
  }

  get pid(): number | null {
    return this.workerPid;
  }

  get available(): boolean {
    return this.connected && !this.stopping;
  }

  get workerPane(): HerdrWorkerPane | null {
    return this.pane;
  }

  private assertStarting(): void {
    if (this.startup.signal.aborted || this.stopping)
      throw new Error("Herdr worker startup was cancelled");
  }

  private fail(error: Error): void {
    this.rejectHandshake(error);
    this.startup.abort();
    if (!this.stopping && this.connected) {
      this.connected = false;
      this.emit("error", error);
    }
  }

  private async start(): Promise<void> {
    if (process.platform !== "linux")
      throw new Error("Herdr-enhanced Pi workers currently require Linux");
    const timeout = setTimeout(
      () => this.fail(new Error("Herdr worker startup timed out")),
      60_000,
    );
    try {
      this.assertStarting();
      await (this.options.assertScopesAvailable?.() ??
        assertHerdrWorkerScopesAvailable(this.launch.env));
      this.assertStarting();
      await this.options.assertWritable?.();
      this.assertStarting();
      this.directory = await mkdtemp(join(tmpdir(), "inspire-herdr-"));
      this.assertStarting();
      const address = join(this.directory, "rpc.sock");
      if (Buffer.byteLength(address) > 100)
        throw new Error(
          "The temporary directory path is too long for a Herdr worker socket",
        );
      const ticket = join(this.directory, "launch.json");
      const command = workerCommand(ticket, this.scopeName);
      this.server = createServer((socket) =>
        this.accept(socket, command.entry, ticket),
      );
      this.server.on("error", (error) => this.fail(error));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(address, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      this.assertStarting();
      await writeFile(
        ticket,
        JSON.stringify({
          version: HERDR_BRIDGE_VERSION,
          address,
          token: this.token,
        }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      this.assertStarting();
      this.pane = await this.options.client.createWorkerPane(
        this.launch.cwd,
        this.options.label,
        command.argv,
      );
      this.assertStarting();
      this.lease = await this.options.registry.create(
        this.launch.cwd,
        this.pane,
        this.directory,
      );
      this.assertStarting();
      this.maybeGrant(command.entry, ticket);
      await this.handshake;
    } finally {
      clearTimeout(timeout);
    }
  }

  private accept(socket: Socket, entry: string, ticket: string): void {
    if (this.stopping || this.sockets.size >= 4) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("error", () => {
      if (socket === this.rpc || socket === this.errors)
        this.fail(new Error("Herdr worker connection failed"));
    });
    socket.once("close", () => {
      this.sockets.delete(socket);
      if (socket === this.rpc || socket === this.errors)
        this.fail(new Error("Herdr worker connection closed"));
    });
    void this.readHello(socket, entry, ticket).catch(() => socket.destroy());
  }

  private async readHello(
    socket: Socket,
    entry: string,
    ticket: string,
  ): Promise<void> {
    const value = await readHerdrBridgeRecord(
      socket,
      this.startup.signal,
      1_024,
    );
    const parsed = herdrBridgeHelloSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid Herdr worker handshake");
    const hello = parsed.data;
    if (!timingSafeEqual(Buffer.from(hello.token), Buffer.from(this.token)))
      throw new Error("Invalid Herdr worker capability");
    this.assertStarting();
    if (this.bridgePid !== null && this.bridgePid !== hello.pid)
      throw new Error("Herdr worker channels disagree about their process");
    if (
      (hello.channel === "rpc" && this.rpc) ||
      (hello.channel === "stderr" && this.errors)
    )
      throw new Error("Herdr worker channel is already connected");
    this.bridgePid = hello.pid;
    if (hello.channel === "rpc") this.rpc = socket;
    else this.errors = socket;
    this.maybeGrant(entry, ticket);
  }

  private maybeGrant(entry: string, ticket: string): void {
    // layout.apply starts the bridge before acknowledging its actual pane ID.
    // Both authenticated channels and persisted ownership must precede Pi.
    if (this.rpc && this.errors && this.lease && !this.granting) {
      this.granting = this.grant(entry, ticket);
      void this.granting.catch((error: Error) => this.fail(error));
    }
  }

  private async grant(entry: string, ticket: string): Promise<void> {
    const rpc = this.rpc!;
    const errors = this.errors!;
    this.group = await captureHerdrProcessGroup(
      this.bridgePid!,
      entry,
      ticket,
      this.scopeName,
    );
    this.assertStarting();
    this.lease = await this.options.registry.grant(this.lease!, this.group);
    this.assertStarting();
    // Retain stderr even if Pi fails before its ready record can be inspected.
    errors.pipe(this.stderr);
    writeHerdrBridgeRecord(rpc, this.launch);
    const ready = herdrBridgeReadySchema.parse(
      await readHerdrBridgeRecord(rpc, this.startup.signal, 1_024),
    );
    await assertHerdrGroupMember(this.group, ready.pid);
    this.assertStarting();
    this.workerPid = ready.pid;
    this.stdin.pipe(rpc);
    rpc.pipe(this.stdout);
    this.connected = true;
    this.resolveHandshake();
  }

  stop(graceful: boolean, diagnostic: PiRpcStopDiagnostic): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.connected = false;
    this.startup.abort();
    this.rejectHandshake(new Error("Herdr worker startup was stopped"));
    this.stopPromise = this.stopInside(graceful, diagnostic);
    return this.stopPromise;
  }

  private async stopInside(
    graceful: boolean,
    diagnostic: PiRpcStopDiagnostic,
  ): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.granting?.catch(() => undefined);
    // Socket death never substitutes for actual worker-group termination.
    if (this.group)
      await stopHerdrProcessGroup(this.group, graceful, diagnostic);
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    if (this.pane) {
      try {
        await this.options.client.closePane(this.pane);
      } catch {
        // Process death is already proven. A stale/closed terminal pane is a
        // topology-cleanup issue, not a reason to retain writer authority.
        diagnostic("worker_pane_cleanup_failed", { paneId: this.pane.paneId });
      }
    }
    try {
      if (this.lease) await this.options.registry.remove(this.lease);
      else if (this.directory)
        await rm(this.directory, { recursive: true, force: true });
    } catch {
      // Keep any unremoved private lease for the next startup's recovery pass.
      diagnostic("worker_lease_cleanup_failed", {});
    }
  }
}
