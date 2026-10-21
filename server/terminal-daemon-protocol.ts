import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import type { TerminalOperationIdentity } from "../shared/terminal-contracts.js";
import { installationKey } from "./installation-key.js";
import {
  inspireRuntimeDirectory,
  inspireStateDirectory,
} from "./platform-paths.mjs";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 3;
export const TERMINAL_DAEMON_READY_TYPE = "terminal_daemon_ready";

export type TerminalDaemonRpcMethod =
  | "ping"
  | "getDaemonInfo"
  | "shutdownDaemon"
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
  requestId: string;
  method: TerminalDaemonRpcMethod;
  params: unknown;
  operation?: TerminalOperationIdentity;
}

/** Maintenance is versioned separately from terminal data RPC/attachments. */
export interface TerminalDaemonLifecycleRequest {
  lifecycleVersion: 1;
  mode: "lifecycle";
  requestId: string;
  method: "getDaemonInfo" | "shutdownDaemon";
  params: unknown;
}

export interface TerminalDaemonAttachRequest {
  protocolVersion: number;
  mode: "attach";
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

type AddressOptions = NonNullable<
  Parameters<typeof inspireRuntimeDirectory>[0]
>;

/** Observe old addresses only to avoid stranding a listening pre-TLS owner.
 * Never send the former plaintext token handshake to an old endpoint. */
export function legacyTerminalDaemonAddress(
  root: string,
  host: string,
  port: number,
  options: AddressOptions = {},
): string {
  const key = installationKey(root, host, port).slice(0, 24);
  if ((options.platform ?? process.platform) === "win32")
    return "\\\\.\\pipe\\inspire-terminal-" + key;
  return posix.join(inspireRuntimeDirectory(options), key + ".terminal.sock");
}

export function defaultTerminalDaemonAddress(
  root: string,
  host: string,
  port: number,
  options: AddressOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const key = installationKey(root, host, port).slice(0, 24);
  if (platform === "win32") {
    // A pipe is machine-wide, unlike a private filesystem directory.
    const account = userInfo();
    const user = createHash("sha256")
      .update(account.username.toLowerCase() + "\0")
      .update(win32.normalize(account.homedir).toLowerCase() + "\0")
      .update(win32.normalize(inspireStateDirectory(options)).toLowerCase())
      .digest("hex")
      .slice(0, 24);
    return "\\\\.\\pipe\\inspire-terminal-" + user + "-" + key;
  }
  const maximum = platform === "darwin" ? 103 : 107;
  const legacy = legacyTerminalDaemonAddress(root, host, port, options);
  if (Buffer.byteLength(legacy) <= maximum) return legacy;
  const shorter = posix.join(inspireRuntimeDirectory(options), key + ".sock");
  if (Buffer.byteLength(shorter) <= maximum) return shorter;
  // TMPDIR can itself exceed sun_path on macOS. /tmp is the OS-provided
  // short shared temporary root; the daemon verifies this user-owned leaf.
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return posix.join("/tmp", "inspire-ipc-" + user, key + ".sock");
}

export function defaultTerminalDaemonTokenPath(
  root: string,
  host: string,
  port: number,
  options: AddressOptions = {},
): string {
  return join(
    inspireStateDirectory(options),
    `${installationKey(root, host, port)}.terminal-token`,
  );
}

export function defaultTerminalDaemonStatePath(
  root: string,
  host: string,
  port: number,
  options: AddressOptions = {},
): string {
  return join(
    inspireStateDirectory(options),
    `${installationKey(root, host, port)}.terminals.json`,
  );
}
