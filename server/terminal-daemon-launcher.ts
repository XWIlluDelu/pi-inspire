import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installationKey } from "./platform-paths.mjs";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  resolveTerminalDaemonConfiguration,
  type TerminalDaemonLaunchOptions,
} from "./terminal-daemon-configuration.js";
import {
  addressAcceptsConnections,
  TERMINAL_DAEMON_OWNER_CONFLICT_EXIT_CODE,
} from "./terminal-daemon-socket.js";
import {
  readTerminalDaemonSecret,
  resolveTerminalDaemonSecret,
} from "./terminal-daemon-tls.js";
import { TerminalServiceError } from "./terminal-service.js";
import {
  independentProcessEnvironment,
  systemdEnvironmentArguments,
} from "./user-environment.mjs";

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 8_000;

async function runSystemdUnit(
  command: string,
  args: string[],
  unit: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  return new Promise<boolean>((resolvePromise) => {
    const child = spawn(
      "systemd-run",
      [
        "--user",
        `--unit=${unit}`,
        "--collect",
        "--quiet",
        "--property=Restart=on-failure",
        `--property=RestartPreventExitStatus=${TERMINAL_DAEMON_OWNER_CONFLICT_EXIT_CODE}`,
        "--property=RestartSec=2s",
        ...systemdEnvironmentArguments(environment),
        "--",
        command,
        ...args,
      ],
      { stdio: "ignore", env: environment },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 2_000);
    const finish = (started: boolean): void => {
      clearTimeout(timer);
      resolvePromise(started);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");

function terminalConnectionFailure(
  error: unknown,
  listening: boolean,
): TerminalServiceError {
  const prefix = sourceMode ? "npm run inspire --" : "inspire";
  const detail =
    error instanceof Error ? error.message : "No authenticated reply.";
  return new TerminalServiceError(
    listening
      ? "terminal_service_connection_unverified"
      : "terminal_daemon_unavailable",
    503,
    (listening
      ? "A terminal endpoint is listening, but its authenticated data connection failed. "
      : "The terminal service is unavailable; no endpoint accepted the connection. ") +
      "Existing terminal processes were left running. " +
      `Run ${prefix} terminal status and inspect the owning service before deciding whether replacement is needed. ` +
      "Replacing that daemon ends its live terminals; an ordinary Inspire restart keeps it running.\n" +
      `Connection check: ${detail}`,
  );
}

/** Recovery only reconnects: no process launch, authority creation or owner replacement. */
export async function connectExistingTerminalDaemon(
  options: TerminalDaemonLaunchOptions,
): Promise<TerminalDaemonClient> {
  const { address, tokenPath } = resolveTerminalDaemonConfiguration(options);
  let client: TerminalDaemonClient | undefined;
  try {
    client = new TerminalDaemonClient(
      address,
      await readTerminalDaemonSecret(tokenPath),
    );
    await client.probe();
    return client;
  } catch (error) {
    await client?.close();
    throw terminalConnectionFailure(
      error,
      await addressAcceptsConnections(address),
    );
  }
}

export async function launchTerminalDaemon(
  options: TerminalDaemonLaunchOptions,
): Promise<TerminalDaemonClient> {
  const environment = options.environment ?? process.env;
  const { root, address, tokenPath, statePath } =
    resolveTerminalDaemonConfiguration(options);
  const token = await resolveTerminalDaemonSecret(tokenPath);
  const client = new TerminalDaemonClient(address, token);
  let probeError: unknown;
  try {
    await client.probe();
    return client;
  } catch (error) {
    probeError = error;
  }

  // A failed probe does not grant authority to stop an independently owned
  // daemon and its PTYs. In particular, an old protocol's replace handshake
  // can terminate active shells. Leave a listening owner untouched.
  if (await addressAcceptsConnections(address)) {
    await client.close();
    throw terminalConnectionFailure(probeError, true);
  }

  const daemonArgs = [
    ...(sourceMode ? [require.resolve("tsx/cli")] : []),
    join(
      dirname(fileURLToPath(import.meta.url)),
      `terminal-daemon-entry.${sourceMode ? "ts" : "js"}`,
    ),
    "--root",
    root,
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--address",
    address,
    "--token-path",
    tokenPath,
    "--state-path",
    statePath,
  ];
  const unit = `inspire-terminal-${installationKey(
    root,
    options.host,
    options.port,
  ).slice(0, 12)}`;
  const startedBySystemd = await runSystemdUnit(
    process.execPath,
    daemonArgs,
    unit,
    environment,
  );
  if (!startedBySystemd) {
    const child = spawn(process.execPath, daemonArgs, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...independentProcessEnvironment(environment),
        INSPIRE_OPEN: "0",
        INSPIRE_QUIET: "1",
      },
    });
    // Detached spawn failures must reject, not escape as an unhandled event.
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.probe();
      return client;
    } catch (error) {
      lastError = error;
      await delay(75);
    }
  }
  throw new Error(
    `Unable to start the Inspire terminal service: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
