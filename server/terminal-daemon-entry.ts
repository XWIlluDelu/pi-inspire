import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { acquireFileLock } from "./file-lock.mjs";
import { processStartIdentity } from "./instance-state.mjs";
import {
  resolveTerminalDaemonConfiguration,
  type TerminalDaemonConfiguration,
  type TerminalDaemonInfo,
} from "./terminal-daemon-configuration.js";
import { TerminalDaemonServer } from "./terminal-daemon-server.js";
import {
  addressAcceptsConnections,
  TERMINAL_DAEMON_OWNER_CONFLICT_EXIT_CODE,
  TerminalDaemonOwnerConflictError,
} from "./terminal-daemon-socket.js";
import { resolveTerminalDaemonSecret } from "./terminal-daemon-tls.js";
import { TerminalHistoryStore } from "./terminal-history-store.js";
import { TerminalServiceError } from "./terminal-service.js";
import { TerminalSessionManager } from "./terminal-session-manager.js";
import { ensureTerminalShellIntegration } from "./terminal-shell-integration.js";
import {
  prepareTerminalStateDirectory,
  readTerminalState,
  TerminalStateWriter,
} from "./terminal-state-store.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function configuration(): TerminalDaemonConfiguration {
  const environment = { ...process.env };
  for (const [flag, key] of [
    ["--address", "INSPIRE_TERMINAL_DAEMON_ADDRESS"],
    ["--token-path", "INSPIRE_TERMINAL_TOKEN_PATH"],
    ["--state-path", "INSPIRE_TERMINAL_STATE_PATH"],
  ]) {
    const value = argument(flag!);
    if (value !== undefined) environment[key!] = value;
  }
  return resolveTerminalDaemonConfiguration({
    root: resolve(argument("--root") ?? process.cwd()),
    host: argument("--host") ?? process.env.INSPIRE_HOST ?? "127.0.0.1",
    port: Number(argument("--port") ?? process.env.INSPIRE_PORT ?? "4587"),
    environment,
  });
}

async function notifySystemdReady(): Promise<void> {
  if (!process.env.NOTIFY_SOCKET) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "systemd-notify",
      ["--ready", "--status=Accepting terminal connections"],
      { stdio: "ignore" },
    );
    child.once("error", rejectPromise);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error("Unable to notify systemd readiness")),
    );
  });
}

async function installedSystemdUnit(): Promise<string | null> {
  if (process.platform !== "linux" || !process.env.NOTIFY_SOCKET) return null;
  const groups = await readFile("/proc/self/cgroup", "utf8");
  for (const group of groups.split("\n")) {
    const unit = basename(
      group.slice(group.indexOf(":", group.indexOf(":") + 1) + 1),
    );
    // Only the product's dedicated terminal unit is restart authority. An
    // arbitrary enclosing Host/custom service must not become our target.
    if (unit === "inspire-terminal.service") return unit;
  }
  return null;
}

async function main(): Promise<void> {
  const config = configuration();
  if (await addressAcceptsConnections(config.address))
    throw new TerminalDaemonOwnerConflictError();
  const token = await resolveTerminalDaemonSecret(config.tokenPath);
  await prepareTerminalStateDirectory(config.statePath);
  // Keep one writer/PTY owner through startup and the complete shutdown drain.
  const lease = await acquireFileLock(config.statePath + ".daemon.lock", {
    waitMs: 8_000,
    label: "terminal daemon",
  });
  let manager: TerminalSessionManager | undefined;
  let daemon: TerminalDaemonServer | undefined;
  try {
    const report = (error: unknown): void => {
      console.error(error instanceof Error ? error.message : String(error));
    };
    const history = new TerminalHistoryStore(
      config.statePath + ".history",
      report,
    );
    let shellIntegrationDirectory: string | undefined =
      config.statePath + ".shell";
    try {
      await ensureTerminalShellIntegration(shellIntegrationDirectory);
    } catch (error) {
      shellIntegrationDirectory = undefined;
      report(error);
    }
    let writer: TerminalStateWriter | null = null;
    let persistChanges = true;
    manager = new TerminalSessionManager({
      history,
      shellIntegrationDirectory,
      onChange: () => {
        if (persistChanges) writer?.schedule();
      },
    });
    writer = new TerminalStateWriter(
      config.statePath,
      () => manager!.exportState(),
      report,
    );
    const previousState = await readTerminalState(config.statePath);
    if (previousState) await manager.restoreState(previousState);

    const instanceId = randomUUID();
    const processStartTime = await processStartIdentity(process.pid);
    const systemdUnit = await installedSystemdUnit();
    let stopping: Promise<void> | null = null;
    let shutdownRequested = false;
    let scheduled = false;
    let retentionTimer: NodeJS.Timeout | undefined;
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      shutdownRequested = true;
      persistChanges = false;
      stopping = (async () => {
        if (retentionTimer) clearInterval(retentionTimer);
        await writer!.flush();
        await daemon!.stop();
        await lease.release();
      })().catch((error) => {
        stopping = null;
        throw error;
      });
      return stopping;
    };
    const finishStop = (): void => {
      scheduled = false;
      void stop().then(() => process.exit(0), report);
    };
    daemon = new TerminalDaemonServer(config.address, token, manager, {
      info: (): TerminalDaemonInfo => ({
        lifecycleVersion: 1,
        instanceId,
        pid: process.pid,
        processStartTime,
        configuration: config,
        systemdUnit,
        stopping: shutdownRequested,
        runningTerminals: manager!
          .list()
          .terminals.filter((t) => t.status === "running").length,
      }),
      shutdown: (expectedId, force) => {
        if (expectedId !== instanceId)
          throw new TerminalServiceError(
            "terminal_owner_changed",
            409,
            "The terminal daemon owner changed; inspect it again.",
          );
        manager!.prepareShutdown(force);
        shutdownRequested = true;
        if (!stopping && !scheduled) {
          scheduled = true;
          // Let the acceptance response flush; the caller still confirms actual
          // process exit, never treating the reply/socket disappearance as exit.
          setTimeout(finishStop, 25);
        }
      },
    });
    await daemon.start();
    await notifySystemdReady();
    process.title = "inspire-terminal";
    retentionTimer = setInterval(
      () => {
        const settings = manager!.getSettings();
        if (settings.persistOutput)
          void history.prune(settings.historyRetentionDays).catch(report);
      },
      6 * 60 * 60 * 1_000,
    );
    retentionTimer.unref();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, finishStop);
  } catch (error) {
    if (daemon) await daemon.stop();
    else await manager?.close();
    await lease.release();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error instanceof TerminalDaemonOwnerConflictError
      ? TERMINAL_DAEMON_OWNER_CONFLICT_EXIT_CODE
      : 1;
});
