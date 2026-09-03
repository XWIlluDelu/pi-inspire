import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveAccessToken } from "./access-token.js";
import {
  defaultTerminalDaemonAddress,
  defaultTerminalDaemonStatePath,
  defaultTerminalDaemonTokenPath,
} from "./terminal-daemon-protocol.js";
import { TerminalDaemonServer } from "./terminal-daemon-server.js";
import { TerminalHistoryStore } from "./terminal-history-store.js";
import { TerminalSessionManager } from "./terminal-session-manager.js";
import { ensureTerminalShellIntegration } from "./terminal-shell-integration.js";
import {
  readTerminalState,
  TerminalStateWriter,
} from "./terminal-state-store.js";

interface DaemonConfiguration {
  root: string;
  host: string;
  port: number;
  address: string;
  tokenPath: string;
  statePath: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4587");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Terminal daemon port must be between 1 and 65535");
  return port;
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
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("Unable to notify systemd readiness"));
    });
  });
}

function configuration(): DaemonConfiguration {
  const root = resolve(argument("--root") ?? process.cwd());
  const host = argument("--host") ?? "127.0.0.1";
  const port = parsePort(argument("--port"));
  return {
    root,
    host,
    port,
    address:
      argument("--address") ?? defaultTerminalDaemonAddress(root, host, port),
    tokenPath:
      argument("--token-path") ??
      defaultTerminalDaemonTokenPath(root, host, port),
    statePath:
      argument("--state-path") ??
      defaultTerminalDaemonStatePath(root, host, port),
  };
}

async function main(): Promise<void> {
  const config = configuration();
  const token = await resolveAccessToken(undefined, config.tokenPath);
  const reportStorageError = (error: unknown): void => {
    console.error(
      `Unable to save terminal data: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  const history = new TerminalHistoryStore(
    `${config.statePath}.history`,
    reportStorageError,
  );
  let shellIntegrationDirectory: string | undefined;
  try {
    shellIntegrationDirectory = `${config.statePath}.shell`;
    await ensureTerminalShellIntegration(shellIntegrationDirectory);
  } catch (error) {
    shellIntegrationDirectory = undefined;
    reportStorageError(error);
  }
  let writer: TerminalStateWriter | null = null;
  let persistChanges = true;
  const manager = new TerminalSessionManager({
    history,
    shellIntegrationDirectory,
    onChange: () => {
      if (persistChanges) writer?.schedule();
    },
  });
  writer = new TerminalStateWriter(
    config.statePath,
    () => manager.exportState(),
    reportStorageError,
  );
  const previousState = await readTerminalState(config.statePath);
  if (previousState) await manager.restoreState(previousState);
  let replaceProtocol = (): void => {};
  const daemon = new TerminalDaemonServer(config.address, token, manager, () =>
    replaceProtocol(),
  );
  await daemon.start();
  try {
    await notifySystemdReady();
  } catch (error) {
    await daemon.stop();
    throw error;
  }
  process.title = "inspire-terminal";
  const retentionTimer = setInterval(
    () => {
      const settings = manager.getSettings();
      if (settings.persistOutput)
        void history
          .prune(settings.historyRetentionDays)
          .catch(reportStorageError);
    },
    6 * 60 * 60 * 1_000,
  );
  retentionTimer.unref();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(retentionTimer);
      // Preserve the pre-shutdown tab catalog. PTY exit callbacks fire while
      // the daemon kills its process trees and must not overwrite it with an
      // empty shutdown snapshot.
      persistChanges = false;
      await writer?.flush();
      await daemon.stop();
    })();
    return stopping;
  };
  replaceProtocol = () => {
    void stop().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop().finally(() => process.exit(0));
    });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
