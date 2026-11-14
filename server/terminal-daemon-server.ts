import { chmod, lstat, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import { createServer, type Server } from "node:tls";
import { decodeTerminalInputFrame } from "../shared/terminal-contracts.js";
import {
  terminalAttachmentSchema,
  terminalControlSchema,
  terminalOperationSchema,
} from "../shared/terminal-operations.js";
import { ensurePrivateDirectory } from "./private-directory.js";
import type { TerminalDaemonInfo } from "./terminal-daemon-configuration.js";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_READY_TYPE,
  type TerminalDaemonAttachRequest,
  type TerminalDaemonRpcRequest,
  type TerminalDaemonRpcResponse,
} from "./terminal-daemon-protocol.js";
import {
  addressAcceptsConnections,
  TerminalDaemonOwnerConflictError,
} from "./terminal-daemon-socket.js";
import { terminalDaemonTlsOptions } from "./terminal-daemon-tls.js";
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
import type { TerminalAttachment } from "./terminal-service.js";
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

async function prepareUnixSocket(address: string): Promise<void> {
  await ensurePrivateDirectory(dirname(address), "terminal IPC directory");
  try {
    const info = await lstat(address);
    if (!info.isSocket() || info.isSymbolicLink())
      throw new Error(`The terminal IPC path is not a socket: ${address}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(
        `The terminal IPC socket is owned by another user: ${address}`,
      );
    if (await addressAcceptsConnections(address))
      throw new TerminalDaemonOwnerConflictError();
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
  private readonly connections = new Set<Socket>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly terminals: TerminalService,
    private readonly lifecycle?: {
      info(): TerminalDaemonInfo;
      shutdown(instanceId: string, force: boolean): void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(this.address) >
        (process.platform === "darwin" ? 103 : 107)
    )
      throw new Error(
        "The terminal IPC socket path is too long; use a shorter INSPIRE_TERMINAL_DAEMON_ADDRESS",
      );
    if (process.platform !== "win32") await prepareUnixSocket(this.address);
    const server = createServer(
      terminalDaemonTlsOptions(this.token),
      (socket) => this.accept(socket),
    );
    // Track unauthenticated TLS connections as well as established attachments,
    // so shutdown never waits on a peer that withheld its handshake.
    server.on("connection", (socket: Socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
    });
    server.on("tlsClientError", () => {});
    server.maxConnections = CONNECTION_LIMIT;
    try {
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
    } catch (error) {
      for (const socket of this.connections) socket.destroy();
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()));
      if (
        (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
        (await addressAcceptsConnections(this.address))
      )
        throw new TerminalDaemonOwnerConflictError();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      // Keep lifecycle controls available if PTY cleanup fails. Data requests
      // are fenced below; a later explicit shutdown can retry the same owner.
      await this.terminals.close();
      const server = this.server;
      this.server = null;
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      if (server)
        await new Promise<void>((resolvePromise) =>
          server.close(() => resolvePromise()),
        );
      // Node owns unlinking its bound socket; never unlink again after drain.
    })().catch((error) => {
      this.stopPromise = null;
      throw error;
    });
    return this.stopPromise;
  }

  private accept(socket: Socket): void {
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
    handshakeTimeout.unref();

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
        } else attachment.control(terminalControlSchema.parse(message));
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
          if (message.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION)
            throw new Error("Terminal daemon protocol is not compatible");
          if (
            this.stopping &&
            !(
              message.mode === "rpc" &&
              (message.method === "getDaemonInfo" ||
                message.method === "shutdownDaemon")
            )
          )
            throw new Error("Terminal service is stopping");
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
                if (socket.destroyed) return;
                try {
                  sendJson({
                    type: "terminal_daemon_error",
                    error: errorPayload(error),
                  });
                  socket.end();
                } catch {
                  // An attach can fail after its Host disconnects or falls
                  // behind. Reporting that failure must not crash the daemon.
                  socket.destroy();
                }
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
      response.result = await this.dispatchRpc(request);
      response.ok = true;
    } catch (error) {
      response.error = errorPayload(error);
    }
    if (!socket.destroyed) socket.end(encodeTerminalIpcJson(response));
  }

  private async dispatchRpc(
    request: TerminalDaemonRpcRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "ping":
        return {
          protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
          operationEpoch: await this.terminals.operationEpoch(),
        };
      case "getCatalog": {
        const { projectCwd } = asRecord(request.params);
        if (projectCwd !== undefined && typeof projectCwd !== "string")
          throw new Error("projectCwd must be a string");
        return this.terminals.list(projectCwd);
      }
      case "getSettings":
        return this.terminals.getSettings();
      case "getDaemonInfo":
      case "shutdownDaemon": {
        if (!this.lifecycle)
          throw new TerminalServiceError(
            "terminal_lifecycle_unavailable",
            503,
            "This daemon has no lifecycle owner.",
          );
        if (request.method === "getDaemonInfo") return this.lifecycle.info();
        const values = asRecord(request.params);
        if (
          typeof values.force !== "boolean" ||
          typeof values.instanceId !== "string"
        )
          throw new Error("Invalid shutdown parameters");
        this.lifecycle.shutdown(values.instanceId, values.force);
        return null;
      }
      case "operate":
      case "observeOperation": {
        const operation = terminalOperationSchema.safeParse(request.params);
        if (!operation.success)
          throw new TerminalServiceError(
            "terminal_method_invalid",
            400,
            "Invalid terminal operation.",
          );
        return this.terminals.operate(
          operation.data,
          request.method === "observeOperation",
        );
      }
      default:
        throw new TerminalServiceError(
          "terminal_method_invalid",
          400,
          "Unknown terminal operation.",
        );
    }
  }

  private handleAttach(
    socket: Socket,
    request: TerminalDaemonAttachRequest,
    sendJson: (value: unknown) => void,
  ): Promise<TerminalAttachment> {
    const options = terminalAttachmentSchema.parse(request.options);
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
