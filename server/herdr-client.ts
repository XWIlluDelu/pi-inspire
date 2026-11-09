import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { HerdrApiError, HerdrControl } from "./herdr-control.js";
import { systemdEnvironmentArguments } from "./user-environment.mjs";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 8_000;
const SERVER_START_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

interface HerdrClientOptions {
  binary?: string;
  environment?: NodeJS.ProcessEnv;
  session?: string;
}

interface HerdrProbe {
  installed: boolean;
  running: boolean;
  compatible: boolean | null;
  version: string | null;
  issue?: string;
}

export interface HerdrWorkerPane {
  serverId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
}

export type HerdrWorkerState = "idle" | "working" | "blocked";

/** Herdr's own custom-agent namespace; unlike `pi`, this does not describe a
 * native Pi TUI or advertise a resumable TUI process to Herdr. */
const WORKER_SOURCE = "inspire:rpc";
const WORKER_AGENT = "inspire-rpc";
const WORKER_METADATA_SOURCE = "inspire:rpc-session";
const WORKER_SESSION_TOKEN = "inspire_session_id";

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected Herdr CLI response");
  return value as JsonObject;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Herdr did not return a ${name}`);
  return value;
}

function paneKey(pane: HerdrWorkerPane): string {
  return `${pane.serverId}:${pane.paneId}`;
}

type ServerProbe = HerdrProbe & { socket?: string; protocol?: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `INSPIRE_HERDR_ENV_EXCLUDE` lists comma-separated environment prefixes kept
 * out of the shared Herdr server. `INSPIRE_` is always excluded.
 */
export function herdrExcludedEnvironmentPrefixes(
  environment: NodeJS.ProcessEnv,
): string[] {
  return (environment.INSPIRE_HERDR_ENV_EXCLUDE ?? "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix));
}

/** Addressed Herdr control; only explicitly allocated worker panes are owned. */
export class HerdrClient {
  private readonly binary: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly prefix: string[];
  private readonly workspaces = new Map<
    string,
    { id: string; serverId: string }
  >();
  private readonly panes = new Map<string, HerdrWorkerPane & { cwd: string }>();
  private readonly topology = new Map<string, Promise<unknown>>();
  private readonly closing = new Map<string, Promise<void>>();
  private ensuring: Promise<void> | null = null;
  private control: HerdrControl | null = null;
  private connecting: Promise<HerdrControl> | null = null;
  private closed = false;

  constructor(options: HerdrClientOptions = {}) {
    this.binary = options.binary ?? "herdr";
    this.environment = { ...(options.environment ?? process.env) };
    // A Host launched inside a Herdr pane must still address the local default
    // server, not its calling pane/socket/session. Only an explicit option opts
    // into a named session; no operation uses focused or --current topology.
    for (const key of [
      "HERDR_ENV",
      "HERDR_SESSION",
      "HERDR_SOCKET_PATH",
      "HERDR_CLIENT_SOCKET_PATH",
      "HERDR_PANE_ID",
      "HERDR_TAB_ID",
      "HERDR_WORKSPACE_ID",
    ])
      delete this.environment[key];
    // Shared Herdr must not inherit Host/worker capabilities. Each actual Pi
    // gets its own Inspire fields later over the private launch channel.
    // Extension-owned per-process identities are a configurable list rather
    // than core knowledge of any one extension.
    const excluded = [
      "INSPIRE_",
      ...herdrExcludedEnvironmentPrefixes(this.environment),
    ];
    for (const key of Object.keys(this.environment))
      if (excluded.some((prefix) => key.startsWith(prefix)))
        delete this.environment[key];
    this.prefix = options.session ? ["--session", options.session] : [];
  }

  private async cli(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      this.binary,
      [...this.prefix, ...args],
      {
        env: this.environment,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
      },
    );
    return stdout;
  }

  async probe(): Promise<HerdrProbe> {
    const {
      socket: _socket,
      protocol: _protocol,
      ...probe
    } = await this.readServerStatus();
    return probe;
  }

  private async readServerStatus(): Promise<ServerProbe> {
    let response: string;
    try {
      response = await this.cli(["status", "server", "--json"]);
    } catch (error) {
      return {
        installed: !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ),
        running: false,
        compatible: null,
        version: null,
        issue: "Herdr server status could not be read",
      };
    }
    try {
      const status = object(JSON.parse(response));
      if (status.status === "not_running" && status.running === false)
        return {
          installed: true,
          running: false,
          compatible: null,
          version: null,
        };
      if (status.status === "running" && status.running === true)
        return {
          installed: true,
          running: true,
          compatible: status.compatible === true,
          version: typeof status.version === "string" ? status.version : null,
          socket: typeof status.socket === "string" ? status.socket : undefined,
          protocol:
            typeof status.protocol === "number" ? status.protocol : undefined,
        };
    } catch {
      // An unexpected CLI/protocol response must not trigger server startup.
    }
    return {
      installed: true,
      running: false,
      compatible: null,
      version: null,
      issue: "Herdr returned an unrecognized server status",
    };
  }

  async ensureServer(): Promise<void> {
    if (!this.ensuring) {
      const attempt = this.ensureServerInside();
      this.ensuring = attempt;
      void attempt.then(
        () => {
          if (this.ensuring === attempt) this.ensuring = null;
        },
        () => {
          if (this.ensuring === attempt) this.ensuring = null;
        },
      );
    }
    return this.ensuring;
  }

  private async ensureServerInside(): Promise<void> {
    const initial = await this.probe();
    if (!initial.installed) throw new Error("Herdr CLI is not installed");
    if (initial.issue) throw new Error(initial.issue);
    if (initial.running) {
      if (initial.compatible) return;
      throw new Error(
        "Running Herdr server is incompatible; Inspire will not restart it",
      );
    }

    // The installed CLI reports its own absolute executable path. A transient
    // user unit cannot depend on the Host process's PATH to find `herdr`.
    const client = object(
      JSON.parse(await this.cli(["status", "client", "--json"])),
    );
    const executable = id(client.binary, "CLI executable path");
    if (!isAbsolute(executable))
      throw new Error("Herdr CLI did not report an absolute executable path");
    const args = [...this.prefix, "server"];
    if (
      process.platform === "linux" &&
      (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID)
    ) {
      // Setsid alone does not leave a systemd Host service's cgroup. If a
      // transient user unit cannot be started, fail instead of launching a
      // server that the next Host restart could inadvertently kill. A direct
      // non-service Host can use the detached path without requiring a user bus.
      await execFileAsync(
        "systemd-run",
        [
          "--user",
          `--unit=inspire-herdr-${randomBytes(6).toString("hex")}`,
          "--collect",
          "--quiet",
          ...systemdEnvironmentArguments(this.environment),
          "--",
          executable,
          ...args,
        ],
        {
          env: this.environment,
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: 128 * 1024,
        },
      );
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, {
          env: this.environment,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    }
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.probe();
      if (status.running && status.compatible) return;
      if (status.issue || (status.running && !status.compatible))
        throw new Error(
          "Herdr server started but is incompatible or unavailable",
        );
      await delay(75);
    }
    throw new Error("Herdr server did not become available after startup");
  }

  private async connection(): Promise<HerdrControl> {
    if (this.closed) throw new Error("Herdr client is closed");
    if (this.control?.available) return this.control;
    if (this.connecting) return this.connecting;
    const attempt = (async () => {
      const status = await this.readServerStatus();
      if (
        status.issue ||
        !status.running ||
        !status.compatible ||
        !status.socket ||
        status.protocol === undefined
      )
        throw new Error("A compatible Herdr server is not available");
      const connection = await HerdrControl.open(
        status.socket,
        status.protocol,
      );
      if (this.closed) {
        connection.close();
        throw new Error("Herdr client is closed");
      }
      this.control = connection;
      return connection;
    })();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  close(): void {
    this.closed = true;
    this.control?.close();
  }

  private queueTopology<T>(
    cwd: string,
    operation: () => Promise<T>,
    allowCleanupAfterFailure = false,
  ): Promise<T> {
    const previous = this.topology.get(cwd);
    // An ambiguous failed create must not make overlapping callers recreate
    // the workspace. Cleanup of an already owned pane remains possible.
    const ready = allowCleanupAfterFailure
      ? previous?.catch(() => undefined)
      : previous;
    const next = ready ? ready.then(operation) : operation();
    this.topology.set(cwd, next);
    void next.then(
      () => {
        if (this.topology.get(cwd) === next) this.topology.delete(cwd);
      },
      () => {
        if (this.topology.get(cwd) === next) this.topology.delete(cwd);
      },
    );
    return next;
  }

  async createWorkerPane(
    cwd: string,
    label: string,
    argv: string[],
  ): Promise<HerdrWorkerPane> {
    if (!isAbsolute(cwd) || !cwd || !label)
      throw new Error("Herdr worker requires an absolute cwd and a label");
    if (
      !argv[0] ||
      argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      throw new Error(
        "Herdr worker argv requires an executable and no NUL bytes",
      );
    return this.queueTopology(cwd, () =>
      this.createPaneInside(cwd, label, argv),
    );
  }

  private async createPaneInside(
    cwd: string,
    label: string,
    argv: string[],
  ): Promise<HerdrWorkerPane> {
    if (this.closed) throw new Error("Herdr client is closed");
    if (!this.control?.available) await this.ensureServer();
    const control = await this.connection();
    const cached = this.workspaces.get(cwd);
    let workspaceId =
      cached?.serverId === control.identity ? cached.id : undefined;
    let bootstrap: HerdrWorkerPane | null = null;
    if (!workspaceId) {
      const created = await control.request("workspace.create", {
        cwd,
        label,
        focus: false,
      });
      workspaceId = id(object(created.workspace).workspace_id, "workspace ID");
      bootstrap = {
        serverId: control.identity,
        workspaceId,
        tabId: id(object(created.tab).tab_id, "tab ID"),
        paneId: id(object(created.root_pane).pane_id, "pane ID"),
      };
    }
    try {
      // Only the first workspace needs Herdr's default root tab. Replace that
      // exact private tab; later workers get new argv tabs in the same workspace.
      // No command is typed into a possibly uninitialized interactive shell.
      const result = await control.request("layout.apply", {
        ...(bootstrap
          ? { tab_id: bootstrap.tabId }
          : { workspace_id: workspaceId }),
        focus: false,
        root: { type: "pane", cwd, label, command: argv },
      });
      const layout = object(result.layout);
      const root = object(layout.root);
      if (layout.workspace_id !== workspaceId || root.type !== "pane")
        throw new Error("Herdr returned an unexpected worker layout");
      const pane: HerdrWorkerPane = {
        serverId: control.identity,
        workspaceId,
        tabId: id(layout.tab_id, "tab ID"),
        paneId: id(root.pane_id, "pane ID"),
      };
      if (this.panes.has(paneKey(pane)))
        throw new Error("Herdr returned a duplicate worker pane ID");
      this.workspaces.set(cwd, { id: workspaceId, serverId: control.identity });
      this.panes.set(paneKey(pane), { ...pane, cwd });
      return pane;
    } catch (error) {
      if (
        !bootstrap &&
        error instanceof HerdrApiError &&
        error.code === "workspace_not_found"
      ) {
        // Herdr rejected the cached target before allocating anything. Forget
        // that topology and create once afresh; ambiguous failures never retry.
        this.workspaces.delete(cwd);
        return this.createPaneInside(cwd, label, argv);
      }
      if (bootstrap) {
        // An unsuccessful/uncertain replacement grants no Pi permission. Only
        // this explicitly allocated shell may be cleaned up, never guessed IDs.
        await control
          .request("pane.close", { pane_id: bootstrap.paneId })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /** Only a caller holding a previously persisted, verified private launch
   * lease may restore these exact IDs after Host recovery. Never discover or
   * adopt panes by workspace label, cwd, or a focused Herdr selection. */
  restoreOwnedPane(pane: HerdrWorkerPane & { cwd: string }): void {
    if (
      !isAbsolute(pane.cwd) ||
      !pane.paneId ||
      !pane.tabId ||
      !pane.workspaceId ||
      !pane.serverId ||
      this.panes.has(paneKey(pane))
    )
      throw new Error("Invalid or conflicting Herdr pane ownership");
    this.panes.set(paneKey(pane), { ...pane });
  }

  private async ownedControl(pane: HerdrWorkerPane): Promise<HerdrControl> {
    const owned = this.panes.get(paneKey(pane));
    if (
      !owned ||
      owned.tabId !== pane.tabId ||
      owned.workspaceId !== pane.workspaceId
    )
      throw new Error("Herdr pane is not owned by this client");
    const control = await this.connection();
    if (control.identity !== pane.serverId)
      throw new Error("The Herdr server owning this worker pane has changed");
    return control;
  }

  async reportWorker(
    pane: HerdrWorkerPane,
    report: {
      state: HerdrWorkerState;
      seq: number;
      sessionId?: string;
    },
  ): Promise<void> {
    const control = await this.ownedControl(pane);
    // A custom RPC agent does not get Herdr's native Pi session/restore field.
    // This source-scoped display token conveys only the current Pi identity;
    // it is never by itself proof of a live writer.
    await control.request("pane.report_agent", {
      pane_id: pane.paneId,
      source: WORKER_SOURCE,
      agent: WORKER_AGENT,
      state: report.state,
      seq: report.seq,
    });
    await control.request("pane.report_metadata", {
      pane_id: pane.paneId,
      source: WORKER_METADATA_SOURCE,
      agent: WORKER_AGENT,
      applies_to_source: WORKER_SOURCE,
      seq: report.seq,
      tokens: { [WORKER_SESSION_TOKEN]: report.sessionId ?? null },
    });
  }

  async closePane(pane: HerdrWorkerPane): Promise<void> {
    const key = paneKey(pane);
    if (!this.panes.has(key))
      throw new Error("Herdr pane is not owned by this client");
    const existing = this.closing.get(key);
    if (existing) return existing;
    const owned = this.panes.get(key)!;
    const closing = this.queueTopology(
      owned.cwd,
      async () => {
        const control = await this.connection();
        if (control.identity === owned.serverId) {
          try {
            await control.request("pane.close", { pane_id: owned.paneId });
          } catch (error) {
            // Callers have already fenced Pi. An externally closed pane has
            // nothing left to clean up; uncertain failures retain ownership.
            if (
              !(error instanceof HerdrApiError) ||
              error.code !== "pane_not_found"
            )
              throw error;
          }
        }
        this.panes.delete(key);
        if (![...this.panes.values()].some((pane) => pane.cwd === owned.cwd))
          this.workspaces.delete(owned.cwd);
      },
      true,
    );
    this.closing.set(key, closing);
    void closing.then(
      () => {
        if (this.closing.get(key) === closing) this.closing.delete(key);
      },
      () => {
        if (this.closing.get(key) === closing) this.closing.delete(key);
      },
    );
    return closing;
  }
}
