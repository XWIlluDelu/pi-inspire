import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  terminalOperationSchema,
  type TerminalOperation,
} from "../shared/terminal-operations.js";
import type { TerminalDaemonInfo } from "./terminal-daemon-configuration.js";
import {
  TerminalServiceError,
  type TerminalService,
} from "./terminal-service.js";
import {
  inspireRuntimeDirectory,
  inspireStateDirectory,
  installationKey,
} from "./platform-paths.mjs";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 6;
export const TERMINAL_DAEMON_READY_TYPE = "terminal_daemon_ready";

export interface TerminalDaemonLifecycle {
  info(): TerminalDaemonInfo;
  shutdown(instanceId: string, force: boolean): void;
}

function requireLifecycle(owner?: TerminalDaemonLifecycle) {
  if (owner) return owner;
  throw new TerminalServiceError(
    "terminal_lifecycle_unavailable",
    503,
    "This daemon has no lifecycle owner.",
  );
}

function requestParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Terminal RPC parameters must be an object");
  return value as Record<string, unknown>;
}

function mutation(
  terminal: TerminalService,
  params: unknown,
  observeOnly: boolean,
) {
  const operation = terminalOperationSchema.safeParse(params);
  if (!operation.success)
    throw new TerminalServiceError(
      "terminal_method_invalid",
      400,
      "Invalid terminal operation.",
    );
  return terminal.operate(operation.data, observeOnly);
}

/** Both transports use these service calls. Only the IPC side decodes its request envelope. */
export const terminalDaemonMethods = {
  async ping(terminal: TerminalService) {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      operationEpoch: await terminal.operationEpoch(),
    };
  },
  getCatalog(terminal: TerminalService, params: unknown) {
    const { projectCwd } = requestParams(params);
    if (projectCwd !== undefined && typeof projectCwd !== "string")
      throw new Error("projectCwd must be a string");
    return terminal.list(projectCwd);
  },
  getSettings(terminal: TerminalService) {
    return terminal.getSettings();
  },
  getDaemonInfo(
    _terminal: TerminalService,
    _params: unknown,
    owner?: TerminalDaemonLifecycle,
  ) {
    return requireLifecycle(owner).info();
  },
  shutdownDaemon(
    _terminal: TerminalService,
    params: unknown,
    owner?: TerminalDaemonLifecycle,
  ) {
    const lifecycle = requireLifecycle(owner);
    const { instanceId, force } = requestParams(params);
    if (typeof instanceId !== "string" || typeof force !== "boolean")
      throw new Error("Invalid shutdown parameters");
    lifecycle.shutdown(instanceId, force);
    return null;
  },
  operate: (terminal: TerminalService, params: unknown) =>
    mutation(terminal, params, false),
  observeOperation: (terminal: TerminalService, params: unknown) =>
    mutation(terminal, params, true),
};

export type TerminalDaemonRpcMethod = keyof typeof terminalDaemonMethods;
export type TerminalDaemonRpcResult<Method extends TerminalDaemonRpcMethod> =
  Awaited<ReturnType<(typeof terminalDaemonMethods)[Method]>>;
type RpcInputs = {
  getCatalog: { projectCwd?: string };
  shutdownDaemon: { instanceId: string; force: boolean };
  operate: TerminalOperation;
  observeOperation: TerminalOperation;
};
export type TerminalDaemonRpcParams<Method extends TerminalDaemonRpcMethod> =
  Method extends keyof RpcInputs ? RpcInputs[Method] : Record<string, never>;

export function dispatchTerminalDaemonRpc(
  terminal: TerminalService,
  owner: TerminalDaemonLifecycle | undefined,
  method: unknown,
  params: unknown,
) {
  if (
    typeof method !== "string" ||
    !Object.hasOwn(terminalDaemonMethods, method)
  )
    throw new TerminalServiceError(
      "terminal_method_invalid",
      400,
      "Unknown terminal operation.",
    );
  return terminalDaemonMethods[method as TerminalDaemonRpcMethod](
    terminal,
    params,
    owner,
  );
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
  const standard = posix.join(
    inspireRuntimeDirectory(options),
    key + ".terminal.sock",
  );
  if (Buffer.byteLength(standard) <= maximum) return standard;
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
