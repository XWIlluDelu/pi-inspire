import { join, resolve } from "node:path";
import type { HerdrEnhancementStatus } from "../shared/herdr.js";
import { type DiagnosticLogger, nullDiagnosticLogger } from "./diagnostics.js";
import { HerdrClient } from "./herdr-client.js";
import {
  assertHerdrWorkerScopesAvailable,
  herdrProcessIsLive,
  stopHerdrProcessGroup,
} from "./herdr-process-group.js";
import { HerdrRpcTransport } from "./herdr-rpc-transport.js";
import {
  HerdrWorkerObserver,
  type HerdrWorkerProjection,
} from "./herdr-worker-observer.js";
import { HerdrWorkerRegistry } from "./herdr-worker-registry.js";
import { installationKey } from "./installation-key.js";
import { type PiRpcOptions, PiRpcProcess } from "./pi-rpc.js";
import { inspireStateDirectory } from "./platform-paths.mjs";
import { requestError } from "./request-error.js";
import type { RuntimeWorkerStatus } from "./runtime.js";

interface HerdrEnhancementOptions {
  enabled: boolean;
  mock?: boolean;
  registry: HerdrWorkerRegistry;
  client?: HerdrClient;
  diagnostics?: DiagnosticLogger;
}

export function defaultHerdrWorkerDirectory(
  root: string,
  host: string,
  port: number,
): string {
  return join(
    inspireStateDirectory(),
    "herdr-workers",
    installationKey(root, host, port),
  );
}

/** The optional placement module. Runtime keeps its single process factory,
 * session authority and scheduler; neither it nor the UI speaks bridge IPC.
 */
export class HerdrEnhancement {
  private clientInstance: HerdrClient | null;
  private observerInstance: HerdrWorkerObserver | null = null;
  private readonly projections = new WeakMap<
    PiRpcProcess,
    HerdrWorkerProjection
  >();
  private initialization: Promise<void> | null = null;
  private initialized = false;
  private recoveryIssue: string | undefined;
  private scopeCheck: Promise<void> | null = null;
  private closed = false;
  private readonly diagnostics: DiagnosticLogger;

  constructor(private readonly options: HerdrEnhancementOptions) {
    this.clientInstance = options.client ?? null;
    this.diagnostics = options.diagnostics ?? nullDiagnosticLogger();
  }

  private get client(): HerdrClient {
    return (this.clientInstance ??= new HerdrClient());
  }

  private get observer(): HerdrWorkerObserver {
    return (this.observerInstance ??= new HerdrWorkerObserver({
      client: this.client,
      onError: (error) => this.recordError("herdr_projection_failed", error),
    }));
  }

  private recordError(event: string, error: unknown): void {
    this.diagnostics.record("warning", event, {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: (error as NodeJS.ErrnoException | null)?.code,
    });
  }

  /** Start early without holding the HTTP server behind an unkillable old
   * process. Admission remains closed until recovery really completes. Even a
   * switch back to direct mode must fence a previous enhanced writer first.
   */
  initialize(): Promise<void> {
    return (this.initialization ??= this.recover());
  }

  private async recover(): Promise<void> {
    try {
      if (this.options.mock || process.platform !== "linux") return;
      const leases = await this.options.registry.list();
      // Starting a second Host on an occupied address must not kill the first
      // Host's workers before listen() has a chance to reject that address.
      for (const lease of leases) {
        if (await herdrProcessIsLive(lease.owner)) {
          this.recoveryIssue =
            "Another Inspire Host still owns enhanced sessions for this address";
          return;
        }
      }
      for (const lease of leases) {
        if (lease.group) {
          await stopHerdrProcessGroup(lease.group, false, (event, fields) => {
            this.diagnostics.record("warning", event, fields);
          });
        }
        // Terminal geometry is secondary to the now-proven writer fence. A
        // missing daemon or changed incarnation cannot authorize another pane.
        try {
          this.client.restoreOwnedPane({ ...lease.pane, cwd: lease.cwd });
          await this.client.closePane(lease.pane);
        } catch (error) {
          this.recordError("herdr_recovery_pane_cleanup_failed", error);
        }
        try {
          await this.options.registry.remove(lease);
        } catch (error) {
          this.recordError("herdr_recovery_lease_cleanup_failed", error);
        }
      }
    } catch (error) {
      this.recoveryIssue =
        (error as NodeJS.ErrnoException | null)?.code ===
        "HERDR_LEGACY_WORKER_LEASE"
          ? "Previous-version Herdr workers have no retained tool scope, so detached tool exit cannot be verified. Shut down the old environment, then reboot this machine to clear the old boot's ownership fence"
          : "Previous enhanced sessions could not be verified as stopped. Check the Host diagnostics before starting new work";
      this.recordError("herdr_recovery_failed", error);
    } finally {
      this.initialized = true;
    }
  }

  private checkWorkerScopes(refresh = false): Promise<void> {
    if (this.scopeCheck && !refresh) return this.scopeCheck;
    const attempt = assertHerdrWorkerScopesAvailable(process.env);
    this.scopeCheck = attempt;
    void attempt.catch(() => {
      // A repaired user manager must be usable without restarting the Host.
      if (this.scopeCheck === attempt) this.scopeCheck = null;
    });
    return attempt;
  }

  createProcess(options: PiRpcOptions): PiRpcProcess {
    if (this.closed) throw requestError("The Host is shutting down", 503);
    if (!this.initialized)
      throw requestError(
        "The Host is still stopping previous enhanced sessions",
        503,
      );
    if (this.recoveryIssue) throw requestError(this.recoveryIssue, 503);
    if (!this.options.enabled || this.options.mock)
      return new PiRpcProcess(options);
    if (process.platform !== "linux")
      throw requestError("Herdr enhancement currently requires Linux", 503);

    const sessionIndex = options.args?.indexOf("--session") ?? -1;
    const sessionFile =
      sessionIndex >= 0 ? options.args?.[sessionIndex + 1] : undefined;
    let transport: HerdrRpcTransport | null = null;
    const rpc = new PiRpcProcess({
      ...options,
      createTransport: (launch) =>
        (transport = new HerdrRpcTransport(launch, {
          client: this.client,
          registry: this.options.registry,
          label: "Inspire Pi",
          assertScopesAvailable: () => this.checkWorkerScopes(),
          ...(sessionFile
            ? {
                assertWritable: () =>
                  this.observer.assertWritable(
                    options.sessionId,
                    resolve(options.cwd, sessionFile),
                  ),
              }
            : {}),
        })),
    });
    const projection = this.observer.observe(
      () => transport?.workerPane ?? null,
    );
    this.projections.set(rpc, projection);
    const dispose = () => {
      this.projections.delete(rpc);
      rpc.off("exit", dispose);
      rpc.off("stopped", dispose);
      void projection.dispose();
    };
    rpc.once("exit", dispose);
    rpc.once("stopped", dispose);
    return rpc;
  }

  updateWorkerStatus(rpc: PiRpcProcess, status: RuntimeWorkerStatus): void {
    this.projections.get(rpc)?.update(status);
  }

  async status(): Promise<HerdrEnhancementStatus> {
    const enabled = this.options.enabled && !this.options.mock;
    const supported = process.platform === "linux" && !this.options.mock;
    if (this.options.mock) {
      return {
        enabled,
        supported,
        installed: false,
        running: false,
        compatible: null,
        version: null,
        issue: "Herdr enhancement is unavailable in mock mode",
      };
    }
    const probe = await this.client.probe();
    let scopeIssue: string | undefined;
    if (
      supported &&
      probe.installed &&
      !probe.issue &&
      probe.compatible !== false
    ) {
      try {
        // Explicit availability inspection is current; worker starts reuse its
        // successful result, but still verify their own scope before grant.
        await this.checkWorkerScopes(true);
      } catch (error) {
        scopeIssue =
          error instanceof Error
            ? error.message
            : "Herdr worker scope support could not be checked";
      }
    }
    const issue =
      this.recoveryIssue ??
      (!this.initialized
        ? "The Host is still stopping previous enhanced sessions"
        : undefined) ??
      (!supported ? "Herdr enhancement currently requires Linux" : undefined) ??
      (!probe.installed
        ? "Herdr is not installed on this Host"
        : probe.issue) ??
      scopeIssue;
    return {
      enabled,
      supported,
      installed: probe.installed,
      running: probe.running,
      compatible: probe.compatible,
      version: probe.version,
      ...(issue ? { issue } : {}),
    };
  }

  /** Runtime has already stopped its current workers. Recovery belongs to
   * this module and has the same real-exit obligation, not a socket timeout.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.initialization;
    this.clientInstance?.close();
  }
}
