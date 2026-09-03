import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname } from "node:path";
import {
  decodeTerminalInputFrame,
  type TerminalClientControlMessage,
} from "../shared/terminal-contracts.js";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_READY_TYPE,
  TERMINAL_DAEMON_REPLACING_TYPE,
  type TerminalDaemonAttachRequest,
  type TerminalDaemonRpcMethod,
  type TerminalDaemonRpcRequest,
  type TerminalDaemonRpcResponse,
} from "./terminal-daemon-protocol.js";
import {
  decodeTerminalIpcJson,
  encodeTerminalIpcFrame,
  encodeTerminalIpcJson,
  TERMINAL_IPC_DATA_FRAME,
  TERMINAL_IPC_INPUT_FRAME,
  TERMINAL_IPC_JSON_FRAME,
  TerminalIpcDecoder,
  type TerminalIpcFrame,
} from "./terminal-ipc.js";
import type {
  TerminalAttachment,
  TerminalAttachOptions,
} from "./terminal-service.js";
import {
  type TerminalService,
  TerminalServiceError,
} from "./terminal-service.js";

const CONNECTION_LIMIT = 192;
const IPC_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
const ATTACH_PENDING_LIMIT_BYTES = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Terminal IPC message must be an object");
  return value as Record<string, unknown>;
}

function stringParam(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function booleanParam(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function tokenMatches(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.byteLength === candidateBytes.byteLength &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

async function addressAcceptsConnections(address: string): Promise<boolean> {
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

async function prepareUnixSocket(address: string): Promise<void> {
  const directory = dirname(address);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`The terminal IPC directory is invalid: ${directory}`);
  if (
    typeof process.getuid === "function" &&
    directoryInfo.uid !== process.getuid()
  )
    throw new Error(
      `The terminal IPC directory is owned by another user: ${directory}`,
    );
  if ((directoryInfo.mode & 0o077) !== 0) await chmod(directory, 0o700);
  try {
    const info = await lstat(address);
    if (!info.isSocket() || info.isSymbolicLink())
      throw new Error(`The terminal IPC path is not a socket: ${address}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(
        `The terminal IPC socket is owned by another user: ${address}`,
      );
    if (await addressAcceptsConnections(address))
      throw new Error("The Inspire terminal daemon is already running.");
    await rm(address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function errorPayload(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (error instanceof TerminalServiceError)
    return { code: error.code, message: error.message, status: error.status };
  return {
    code: "terminal_daemon_error",
    message: "The terminal service could not complete the request.",
    status: 500,
  };
}

export class TerminalDaemonServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly terminals: TerminalService,
    private readonly onProtocolReplacement: () => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== "win32") await prepareUnixSocket(this.address);
    const server = createServer((socket) => this.accept(socket));
    server.maxConnections = CONNECTION_LIMIT;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const fail = (error: Error): void => rejectPromise(error);
      server.once("error", fail);
      server.listen(this.address, () => {
        server.off("error", fail);
        resolvePromise();
      });
    });
    if (process.platform !== "win32") await chmod(this.address, 0o600);
    this.server = server;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.stopPromise = (async () => {
      if (server)
        await new Promise<void>((resolvePromise) =>
          server.close(() => resolvePromise()),
        );
      await this.terminals.close();
      if (process.platform !== "win32") await rm(this.address, { force: true });
    })();
    return this.stopPromise;
  }

  private accept(socket: Socket): void {
    if (this.stopping || this.sockets.size >= CONNECTION_LIMIT) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const decoder = new TerminalIpcDecoder();
    let authenticated = false;
    let attachment: TerminalAttachment | null = null;
    let attaching = false;
    let pendingFrameBytes = 0;
    const pendingFrames: TerminalIpcFrame[] = [];
    const handshakeTimeout = setTimeout(
      () => socket.destroy(),
      HANDSHAKE_TIMEOUT_MS,
    );
    handshakeTimeout.unref?.();

    const sendJson = (value: unknown): void => {
      this.write(socket, encodeTerminalIpcJson(value));
    };
    const dispatchAttachmentFrame = (frame: TerminalIpcFrame): void => {
      if (!attachment) {
        if (attaching) {
          pendingFrameBytes += frame.payload.byteLength + 5;
          if (pendingFrameBytes > ATTACH_PENDING_LIMIT_BYTES)
            throw new Error("Terminal IPC attach input exceeded its limit");
          pendingFrames.push(frame);
        }
        return;
      }
      if (frame.kind === TERMINAL_IPC_INPUT_FRAME) {
        const input = decodeTerminalInputFrame(frame.payload);
        attachment.writeInput(input.sequence, input.data);
      } else if (frame.kind === TERMINAL_IPC_JSON_FRAME) {
        const message = decodeTerminalIpcJson(frame.payload);
        if (asRecord(message).type === "terminal_daemon_detach") {
          attachment.detach();
          socket.end();
        } else
          attachment.control(
            message as Exclude<
              TerminalClientControlMessage,
              { type: "attach" }
            >,
          );
      } else throw new Error("Terminal daemon received an unknown IPC frame");
    };

    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        )) {
          if (authenticated) {
            dispatchAttachmentFrame(frame);
            continue;
          }
          if (frame.kind !== TERMINAL_IPC_JSON_FRAME)
            throw new Error("Terminal daemon handshake must be JSON");
          const message = asRecord(decodeTerminalIpcJson(frame.payload));
          if (!tokenMatches(this.token, message.token))
            throw new Error("Terminal daemon authentication failed");
          if (message.mode === "replace") {
            if (message.protocolVersion === TERMINAL_DAEMON_PROTOCOL_VERSION)
              throw new Error(
                "A compatible terminal daemon is already running",
              );
            authenticated = true;
            clearTimeout(handshakeTimeout);
            socket.end(
              encodeTerminalIpcJson({
                type: TERMINAL_DAEMON_REPLACING_TYPE,
              }),
              () => setImmediate(this.onProtocolReplacement),
            );
            continue;
          }
          if (message.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION)
            throw new Error("Terminal daemon protocol is not compatible");
          authenticated = true;
          clearTimeout(handshakeTimeout);
          if (message.mode === "rpc") {
            void this.handleRpc(
              socket,
              message as unknown as TerminalDaemonRpcRequest,
            );
          } else if (message.mode === "attach") {
            attaching = true;
            void this.handleAttach(
              socket,
              message as unknown as TerminalDaemonAttachRequest,
              sendJson,
            )
              .then((handle) => {
                if (socket.destroyed) {
                  handle.detach();
                  return;
                }
                attachment = handle;
                attaching = false;
                const queued = pendingFrames.splice(0);
                pendingFrameBytes = 0;
                for (const pending of queued) dispatchAttachmentFrame(pending);
                sendJson({ type: TERMINAL_DAEMON_READY_TYPE });
              })
              .catch((error) => {
                sendJson({
                  type: "terminal_daemon_error",
                  error: errorPayload(error),
                });
                socket.end();
              });
          } else throw new Error("Terminal daemon handshake mode is invalid");
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("error", () => {});
    socket.once("close", () => {
      clearTimeout(handshakeTimeout);
      this.sockets.delete(socket);
      attachment?.detach();
    });
  }

  private async handleRpc(
    socket: Socket,
    request: TerminalDaemonRpcRequest,
  ): Promise<void> {
    const response: TerminalDaemonRpcResponse = {
      requestId: request.requestId,
      ok: false,
    };
    try {
      response.result = await this.dispatchRpc(request.method, request.params);
      response.ok = true;
    } catch (error) {
      response.error = errorPayload(error);
    }
    if (!socket.destroyed) socket.end(encodeTerminalIpcJson(response));
  }

  private dispatchRpc(
    method: TerminalDaemonRpcMethod,
    params: unknown,
  ): Promise<unknown> {
    const values = asRecord(params);
    switch (method) {
      case "ping":
        return Promise.resolve({
          protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        });
      case "getCatalog":
        return Promise.resolve(
          this.terminals.list(stringParam(values, "projectCwd")),
        );
      case "getGlobalCatalog":
        return Promise.resolve(this.terminals.list());
      case "create":
        return this.terminals.create(
          asRecord(values.request) as unknown as Parameters<
            TerminalService["create"]
          >[0],
        );
      case "rename": {
        const title = values.title;
        if (title !== null && typeof title !== "string")
          throw new Error("title must be a string or null");
        return this.terminals.rename(stringParam(values, "id"), { title });
      }
      case "reorder": {
        if (
          !Array.isArray(values.ids) ||
          !values.ids.every((id) => typeof id === "string")
        )
          throw new Error("ids must be an array of strings");
        return this.terminals.reorder(
          stringParam(values, "projectCwd"),
          values.ids as string[],
        );
      }
      case "restart":
        return this.terminals.restart(stringParam(values, "id"));
      case "remove":
        return this.terminals.remove(
          stringParam(values, "id"),
          booleanParam(values, "force"),
        );
      case "getSettings":
        return Promise.resolve(this.terminals.getSettings());
      case "updateSettings":
        return this.terminals.updateSettings(
          asRecord(values.patch) as Parameters<
            TerminalService["updateSettings"]
          >[0],
        );
      case "clearHistory":
        return this.terminals.clearHistory();
    }
  }

  private handleAttach(
    socket: Socket,
    request: TerminalDaemonAttachRequest,
    sendJson: (value: unknown) => void,
  ): Promise<TerminalAttachment> {
    const options = asRecord(
      request.options,
    ) as unknown as TerminalAttachOptions;
    return this.terminals.attach(options, {
      sendControl: sendJson,
      sendData: (frame) => {
        this.write(
          socket,
          encodeTerminalIpcFrame(TERMINAL_IPC_DATA_FRAME, frame),
        );
      },
      close: (code, reason) => {
        if (socket.destroyed) return;
        sendJson({ type: "terminal_daemon_close", code, reason });
        socket.end();
      },
    });
  }

  private write(socket: Socket, frame: Buffer): void {
    if (socket.destroyed) throw new Error("Terminal IPC socket is closed");
    if (socket.writableLength + frame.byteLength > IPC_BUFFER_LIMIT_BYTES) {
      socket.destroy();
      throw new Error("Terminal IPC client is too slow");
    }
    socket.write(frame);
  }
}
