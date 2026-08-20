import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolvePiInstallationIdentity } from "./pi-installation.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import type { RuntimeLike } from "./runtime.js";

const execFile = promisify(execFileCallback);
const IDENTITY_COMMAND_TIMEOUT_MS = 5_000;

export type InspireSourceIdentity =
  | { kind: "source"; revision: string | null }
  | { kind: "package"; version: string | null };

interface MaintenanceRestartReady {
  kind: "ready";
  expiresAt: number;
  updates: Array<"inspire" | "pi">;
}

export type MaintenanceRestartOutcome =
  | MaintenanceRestartReady
  | { kind: "skipped"; reason: string };

interface MaintenanceRestartControllerOptions {
  runtime: RuntimeLike;
  root: string;
  piVersion: string;
  runningSource: InspireSourceIdentity;
  diagnostics: DiagnosticLogger;
  inspectPiVersion?: () => Promise<string>;
  inspectSource?: (root: string) => Promise<InspireSourceIdentity>;
}

/** A package release does not have a mutable checked-out revision. A source
 * checkout with an unclean worktree remains distinct from one with no git
 * authority, so a Pi update can never deploy local edits by accident. */
async function installedPackageVersion(root: string): Promise<string | null> {
  try {
    const { version } = JSON.parse(
      await readFile(`${root}/package.json`, "utf8"),
    ) as { version?: unknown };
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

export async function inspectInspireSource(
  root: string,
): Promise<InspireSourceIdentity> {
  const directory = resolve(root);
  try {
    const [{ stdout: inside }, { stdout: revision }, { stdout: status }] =
      await Promise.all([
        execFile(
          "git",
          ["-C", directory, "rev-parse", "--is-inside-work-tree"],
          {
            encoding: "utf8",
            timeout: IDENTITY_COMMAND_TIMEOUT_MS,
          },
        ),
        execFile("git", ["-C", directory, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          timeout: IDENTITY_COMMAND_TIMEOUT_MS,
        }),
        execFile(
          "git",
          ["-C", directory, "status", "--porcelain", "--untracked-files=all"],
          { encoding: "utf8", timeout: IDENTITY_COMMAND_TIMEOUT_MS },
        ),
      ]);
    if (inside.trim() !== "true")
      return {
        kind: "package",
        version: await installedPackageVersion(directory),
      };
    const value = revision.trim();
    return {
      kind: "source",
      revision: status.trim() === "" && value ? value : null,
    };
  } catch {
    return {
      kind: "package",
      version: await installedPackageVersion(directory),
    };
  }
}

/** Check only already-installed identities. The runner restarts only after the
 * real runtime says every slot is idle; it never acquires updates itself. */
export class MaintenanceRestartController {
  private readonly inspectPiVersion: () => Promise<string>;
  private readonly inspectSource: (
    root: string,
  ) => Promise<InspireSourceIdentity>;

  constructor(private readonly options: MaintenanceRestartControllerOptions) {
    this.inspectPiVersion =
      options.inspectPiVersion ??
      (async () =>
        (
          await resolvePiInstallationIdentity({
            installationRoot: options.root,
          })
        ).version);
    this.inspectSource = options.inspectSource ?? inspectInspireSource;
  }

  async reserve(): Promise<MaintenanceRestartOutcome> {
    if (!this.options.runtime.reserveMaintenanceRestart)
      return this.skip("runtime-unsupported");

    const source = this.options.runningSource;
    if (source.kind === "source" && source.revision === null)
      return this.skip("inspire-source-not-clean");

    let piVersion: string;
    try {
      piVersion = await this.inspectPiVersion();
    } catch {
      return this.skip("pi-identity-unavailable");
    }

    const updates: Array<"inspire" | "pi"> = [];
    if (piVersion !== this.options.piVersion) updates.push("pi");
    const current = await this.inspectSource(this.options.root);
    if (source.kind === "source") {
      if (current.kind !== "source" || current.revision === null)
        return this.skip("inspire-source-not-clean");
      if (current.revision !== source.revision) updates.push("inspire");
    } else {
      if (current.kind !== "package" || !source.version || !current.version)
        return this.skip("inspire-identity-unavailable");
      if (current.version !== source.version) updates.push("inspire");
    }
    if (updates.length === 0) return this.skip("no-update");

    const decision = this.options.runtime.reserveMaintenanceRestart();
    if (decision.kind !== "ready") return this.skip(decision.reason);
    this.options.diagnostics.record("info", "maintenance_restart_ready", {
      updates,
      expiresAt: decision.expiresAt,
    });
    return { kind: "ready", expiresAt: decision.expiresAt, updates };
  }

  private skip(reason: string): MaintenanceRestartOutcome {
    this.options.diagnostics.record("info", "maintenance_restart_skipped", {
      reason,
    });
    return { kind: "skipped", reason };
  }
}
