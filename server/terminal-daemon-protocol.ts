import { join } from "node:path";
import { installationKey } from "./installation-key.js";
import {
  inspireRuntimeDirectory,
  inspireStateDirectory,
} from "./platform-paths.mjs";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1;
export const TERMINAL_DAEMON_READY_TYPE = "terminal_daemon_ready";
export const TERMINAL_DAEMON_REPLACING_TYPE = "terminal_daemon_replacing";

export type TerminalDaemonRpcMethod =
  | "ping"
  | "getCatalog"
  | "getGlobalCatalog"
  | "create"
  | "rename"
  | "reorder"
  | "restart"
  | "remove"
  | "getSettings"
  | "updateSettings"
  | "clearHistory";

export interface TerminalDaemonRpcRequest {
  protocolVersion: number;
  mode: "rpc";
  token: string;
  requestId: string;
  method: TerminalDaemonRpcMethod;
  params: unknown;
}

export interface TerminalDaemonAttachRequest {
  protocolVersion: number;
  mode: "attach";
  token: string;
  terminalId: string;
  options: unknown;
}

export interface TerminalDaemonRpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    status: number;
  };
}

function terminalInstallationKey(
  root: string,
  host: string,
  port: number,
): string {
  return installationKey(root, host, port);
}

export function defaultTerminalDaemonAddress(
  root: string,
  host: string,
  port: number,
): string {
  const key = terminalInstallationKey(root, host, port).slice(0, 24);
  if (process.platform === "win32")
    return `\\\\.\\pipe\\inspire-terminal-${key}`;
  return join(inspireRuntimeDirectory(), `${key}.terminal.sock`);
}

export function defaultTerminalDaemonTokenPath(
  root: string,
  host: string,
  port: number,
): string {
  return join(
    inspireStateDirectory(),
    `${terminalInstallationKey(root, host, port)}.terminal-token`,
  );
}

export function defaultTerminalDaemonStatePath(
  root: string,
  host: string,
  port: number,
): string {
  return join(
    inspireStateDirectory(),
    `${terminalInstallationKey(root, host, port)}.terminals.json`,
  );
}
