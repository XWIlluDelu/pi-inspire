import { resolve } from "node:path";
import {
  defaultTerminalDaemonAddress,
  defaultTerminalDaemonStatePath,
  defaultTerminalDaemonTokenPath,
} from "./terminal-daemon-protocol.js";

export interface TerminalDaemonConfiguration {
  root: string;
  host: string;
  port: number;
  address: string;
  tokenPath: string;
  statePath: string;
}

export interface TerminalDaemonLaunchOptions {
  root: string;
  host: string;
  port: number;
  environment?: NodeJS.ProcessEnv;
}

export function resolveTerminalDaemonConfiguration(
  options: TerminalDaemonLaunchOptions,
): TerminalDaemonConfiguration {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  )
    throw new Error("Terminal daemon port must be between 1 and 65535");
  const environment = options.environment ?? process.env;
  const root = resolve(options.root);
  const paths = { environment };
  const address =
    environment.INSPIRE_TERMINAL_DAEMON_ADDRESS ??
    defaultTerminalDaemonAddress(root, options.host, options.port, paths);
  return {
    root,
    host: options.host,
    port: options.port,
    address: process.platform === "win32" ? address : resolve(root, address),
    tokenPath: resolve(
      root,
      environment.INSPIRE_TERMINAL_TOKEN_PATH ??
        defaultTerminalDaemonTokenPath(root, options.host, options.port, paths),
    ),
    statePath: resolve(
      root,
      environment.INSPIRE_TERMINAL_STATE_PATH ??
        defaultTerminalDaemonStatePath(root, options.host, options.port, paths),
    ),
  };
}

export function sameTerminalDaemonConfiguration(
  left: TerminalDaemonConfiguration,
  right: TerminalDaemonConfiguration,
): boolean {
  return (Object.keys(left) as Array<keyof TerminalDaemonConfiguration>).every(
    (key) => left[key] === right[key],
  );
}

export interface TerminalDaemonInfo {
  lifecycleVersion: 1;
  instanceId: string;
  pid: number;
  processStartTime: string;
  configuration: TerminalDaemonConfiguration;
  runningTerminals: number;
  stopping: boolean;
  systemdUnit: string | null;
}
