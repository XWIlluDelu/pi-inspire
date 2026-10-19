import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installationKey } from "./installation-key.js";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  resolveTerminalDaemonConfiguration,
  type TerminalDaemonLaunchOptions,
} from "./terminal-daemon-configuration.js";
import { legacyTerminalDaemonAddress } from "./terminal-daemon-protocol.js";
import { addressAcceptsConnections } from "./terminal-daemon-socket.js";
import { resolveTerminalDaemonSecret } from "./terminal-daemon-tls.js";
import { TerminalServiceError } from "./terminal-service.js";
import {
  independentProcessEnvironment,
  systemdEnvironmentArguments,
} from "./user-environment.mjs";

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 8_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

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

function daemonCommand(): { command: string; prefix: string[]; entry: string } {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const directory = dirname(fileURLToPath(import.meta.url));
  if (sourceMode)
    return {
      command: process.execPath,
      prefix: [require.resolve("tsx/cli")],
      entry: join(directory, "terminal-daemon-entry.ts"),
    };
  return {
    command: process.execPath,
    prefix: [],
    entry: join(directory, "terminal-daemon-entry.js"),
  };
}

export async function launchTerminalDaemon(
  options: TerminalDaemonLaunchOptions,
): Promise<TerminalDaemonClient> {
  const environment = options.environment ?? process.env;
  const paths = { environment };
  const { root, address, tokenPath, statePath } =
    resolveTerminalDaemonConfiguration(options);
  const token = await resolveTerminalDaemonSecret(tokenPath);
  const client = new TerminalDaemonClient(address, token);
  try {
    await client.probe();
    return client;
  } catch {
    // Start a private daemon below and wait for its authenticated IPC socket.
  }

  // A failed probe does not grant authority to stop an independently owned
  // daemon and its PTYs. In particular, an old protocol's replace handshake
  // can terminate active shells. Leave a listening owner untouched.
  const legacyAddress = environment.INSPIRE_TERMINAL_DAEMON_ADDRESS
    ? address
    : legacyTerminalDaemonAddress(root, options.host, options.port, paths);
  if (
    (await addressAcceptsConnections(address)) ||
    (legacyAddress !== address &&
      (await addressAcceptsConnections(legacyAddress)))
  ) {
    await client.close();
    const prefix = fileURLToPath(import.meta.url).endsWith(".ts")
      ? "npm run inspire --"
      : "inspire";
    const maintenance = `Use ${prefix} terminal status, then ${prefix} terminal restart --force to end terminal work and replace a managed daemon. `;
    throw new TerminalServiceError(
      "terminal_service_restart_required",
      503,
      "The terminal service is incompatible or unavailable. " +
        maintenance +
        (process.platform === "linux"
          ? "Older services without lifecycle controls require their service manager; installed Linux services also support Settings → System → Restart all. "
          : "Older services without lifecycle controls require a one-time manual shutdown. ") +
        "Host-only restart cannot replace it.",
    );
  }

  const executable = daemonCommand();
  const daemonArgs = [
    ...executable.prefix,
    executable.entry,
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
    executable.command,
    daemonArgs,
    unit,
    environment,
  );
  if (!startedBySystemd) {
    const child = spawn(executable.command, daemonArgs, {
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
