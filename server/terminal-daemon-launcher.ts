import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAccessToken } from "./access-token.js";
import { installationKey } from "./installation-key.js";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  defaultTerminalDaemonAddress,
  defaultTerminalDaemonStatePath,
  defaultTerminalDaemonTokenPath,
} from "./terminal-daemon-protocol.js";

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 8_000;

interface TerminalDaemonLaunchOptions {
  root: string;
  host: string;
  port: number;
  environment?: NodeJS.ProcessEnv;
}

function addressAcceptsConnections(address: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection(address);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 250);
    timeout.unref?.();
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolvePromise(false);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function runSystemdUnit(
  command: string,
  args: string[],
  unit: string,
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
        "--",
        command,
        ...args,
      ],
      { stdio: "ignore" },
    );
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0));
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
  const address =
    environment.INSPIRE_TERMINAL_DAEMON_ADDRESS ??
    defaultTerminalDaemonAddress(options.root, options.host, options.port);
  const tokenPath =
    environment.INSPIRE_TERMINAL_TOKEN_PATH ??
    defaultTerminalDaemonTokenPath(options.root, options.host, options.port);
  const statePath =
    environment.INSPIRE_TERMINAL_STATE_PATH ??
    defaultTerminalDaemonStatePath(options.root, options.host, options.port);
  const token = await resolveAccessToken(undefined, tokenPath);
  const client = new TerminalDaemonClient(address, token);
  try {
    await client.probe();
    return client;
  } catch {
    // Start a private daemon below and wait for its authenticated IPC socket.
  }

  if (await client.requestProtocolReplacement()) {
    const replacementDeadline = Date.now() + START_TIMEOUT_MS;
    while (
      Date.now() < replacementDeadline &&
      (await addressAcceptsConnections(address))
    )
      await delay(75);
    if (await addressAcceptsConnections(address))
      throw new Error("The incompatible terminal service did not stop");
  }

  const executable = daemonCommand();
  const daemonArgs = [
    ...executable.prefix,
    executable.entry,
    "--root",
    options.root,
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
    options.root,
    options.host,
    options.port,
  ).slice(0, 12)}`;
  const startedBySystemd = await runSystemdUnit(
    executable.command,
    daemonArgs,
    unit,
  );
  if (!startedBySystemd) {
    const child = spawn(executable.command, daemonArgs, {
      cwd: options.root,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...environment,
        INSPIRE_OPEN: "0",
        INSPIRE_QUIET: "1",
      },
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
