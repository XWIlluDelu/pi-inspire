import { randomUUID } from "node:crypto";
import type { TLSSocket } from "node:tls";
import {
  type TerminalCatalogResponse,
  type TerminalServerControlMessage,
  type TerminalServiceSettings,
} from "../shared/terminal-contracts.js";
import type {
  TerminalAttachOptions,
  TerminalIntent,
  TerminalOperation,
  TerminalOperationResults,
} from "../shared/terminal-operations.js";
import type { TerminalDaemonInfo } from "./terminal-daemon-configuration.js";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_READY_TYPE,
  type TerminalDaemonRpcMethod,
  type TerminalDaemonRpcParams,
  type TerminalDaemonRpcResult,
  type TerminalDaemonRpcResponse,
} from "./terminal-daemon-protocol.js";
import { connectTerminalDaemon } from "./terminal-daemon-tls.js";
import {
  decodeTerminalIpcJson,
  encodeTerminalIpcFrame,
  encodeTerminalIpcJson,
  TERMINAL_IPC_DATA_FRAME,
  TERMINAL_IPC_INPUT_FRAME,
  TERMINAL_IPC_JSON_FRAME,
  TerminalIpcDecoder,
  writeTerminalIpcFrame,
} from "./terminal-ipc.js";
import type {
  TerminalAttachment,
  TerminalAttachmentSink,
  TerminalService,
} from "./terminal-service.js";
import { TerminalServiceError } from "./terminal-service.js";

const RPC_TIMEOUT_MS = 5_000;
// A lifecycle mutation may need graceful stop, process-tree termination and
// PTY output drain before the daemon can acknowledge the result.
const LIFECYCLE_RPC_TIMEOUT_MS = 15_000;
const ATTACH_TIMEOUT_MS = 30_000;

async function* daemonFrames(socket: TLSSocket) {
  const decoder = new TerminalIpcDecoder();
  try {
    for await (const chunk of socket) yield* decoder.push(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE")
      throw connectionLost();
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function daemonError(value: unknown): TerminalServiceError {
  const record = asRecord(value);
  const code = typeof record?.code === "string" ? record.code : "daemon_error";
  const message =
    typeof record?.message === "string"
      ? record.message
      : "The terminal service rejected the request.";
  const status =
    typeof record?.status === "number" && Number.isInteger(record.status)
      ? record.status
      : 503;
  return new TerminalServiceError(code, status, message);
}

function serviceStopping(): TerminalServiceError {
  return new TerminalServiceError(
    "terminal_service_closed", 503, "The terminal service is stopping.",
  );
}

function connectionLost(): TerminalServiceError {
  return new TerminalServiceError(
    "terminal_daemon_unavailable", 503, "The terminal service is unavailable.",
  );
}

export class TerminalDaemonClient implements TerminalService {
  private readonly attachments = new Set<TerminalAttachment>();
  private closed = false;

  constructor(
    private readonly address: string,
    private readonly token: string,
  ) {}

  async probe(): Promise<void> {
    await this.operationEpoch();
  }

  daemonInfo(): Promise<TerminalDaemonInfo> {
    return this.rpc("getDaemonInfo", {});
  }

  async shutdownDaemon(instanceId: string, force: boolean): Promise<void> {
    await this.rpc("shutdownDaemon", { instanceId, force });
  }

  async operationEpoch(): Promise<string> {
    const result = await this.rpc("ping", {});
    return result.operationEpoch;
  }

  operate<I extends TerminalIntent>(
    operation: TerminalOperation & { intent: I },
    observeOnly = false,
  ): Promise<TerminalOperationResults[I["command"]]> {
    const command = operation.intent.command;
    return this.rpc(
      observeOnly ? "observeOperation" : "operate",
      operation,
      command === "remove" || command === "restart"
        ? LIFECYCLE_RPC_TIMEOUT_MS
        : RPC_TIMEOUT_MS,
    ) as Promise<TerminalOperationResults[I["command"]]>;
  }

  list(projectCwd?: string): Promise<TerminalCatalogResponse> {
    return this.rpc("getCatalog", { projectCwd });
  }

  getSettings(): Promise<TerminalServiceSettings> {
    return this.rpc("getSettings", {});
  }

  private connect(
    request:
      | { mode: "attach"; options: TerminalAttachOptions }
      | {
          mode: "rpc";
          requestId: string;
          method: TerminalDaemonRpcMethod;
          params: unknown;
        },
  ) {
    if (this.closed) throw serviceStopping();
    const socket = connectTerminalDaemon(this.address, this.token);
    socket.once("secureConnect", () => {
      socket.write(
        encodeTerminalIpcJson({
          protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
          ...request,
        }),
      );
    });
    return socket;
  }

  async attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    const socket = this.connect({ mode: "attach", options });
    socket.setNoDelay(true);
    const deadline = setTimeout(
      () => socket.destroy(new Error("Terminal daemon attach timed out")),
      ATTACH_TIMEOUT_MS,
    ).unref();
    const frames = daemonFrames(socket);
    const handle: TerminalAttachment = {
      send: (frame) => {
        if (!this.attachments.has(handle) || socket.destroyed)
          throw new Error("Terminal attachment is disconnected");
        const packet =
          "data" in frame
            ? encodeTerminalIpcFrame(TERMINAL_IPC_INPUT_FRAME, frame.data)
            : encodeTerminalIpcJson(frame.control);
        writeTerminalIpcFrame(socket, packet);
      },
      detach: () => {
        if (!this.attachments.delete(handle)) return;
        clearTimeout(deadline);
        if (!socket.destroyed)
          socket.end(encodeTerminalIpcJson({ type: "terminal_daemon_detach" }));
      },
    };
    let first: Record<string, unknown>;
    try {
      const next = await frames.next();
      if (next.done) throw connectionLost();
      const message =
        next.value.kind === TERMINAL_IPC_JSON_FRAME
          ? asRecord(decodeTerminalIpcJson(next.value.payload))
          : null;
      if (message?.type === "terminal_daemon_error")
        throw daemonError(message.error);
      if (message?.type === "terminal_daemon_close")
        throw new TerminalServiceError(
          "terminal_attach_failed",
          503,
          typeof message.reason === "string"
            ? message.reason
            : "Terminal closed",
        );
      if (message?.type !== "attached")
        throw new Error("Terminal daemon did not identify the attachment");
      if (this.closed) throw serviceStopping();
      first = message;
    } catch (error) {
      clearTimeout(deadline);
      socket.destroy();
      await frames.return(undefined);
      throw error;
    }

    this.attachments.add(handle);
    // Publish the handle before replay reaches a sink that can send input immediately.
    const forward = async () => {
      let code = 1012;
      let reason = "Terminal service connection lost";
      try {
        if (!this.attachments.has(handle)) return;
        sink.sendControl(first as unknown as TerminalServerControlMessage);
        for await (const frame of frames) {
          if (!this.attachments.has(handle)) break;
          if (frame.kind === TERMINAL_IPC_DATA_FRAME) {
            sink.sendData(frame.payload);
            continue;
          }
          if (frame.kind !== TERMINAL_IPC_JSON_FRAME) break;
          const message = asRecord(decodeTerminalIpcJson(frame.payload));
          if (message?.type === TERMINAL_DAEMON_READY_TYPE)
            clearTimeout(deadline);
          else if (message?.type === "terminal_daemon_error") break;
          else if (message?.type === "terminal_daemon_close") {
            if (typeof message.code === "number") code = message.code;
            reason =
              typeof message.reason === "string"
                ? message.reason
                : "Terminal closed";
            break;
          } else
            sink.sendControl(
              message as unknown as TerminalServerControlMessage,
            );
        }
      } finally {
        clearTimeout(deadline);
        socket.destroy();
        await frames.return(undefined);
        if (this.attachments.delete(handle)) sink.close(code, reason);
      }
    };
    setImmediate(() => void forward().catch(() => {}));
    return handle;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const attachment of [...this.attachments]) attachment.detach();
    this.attachments.clear();
  }

  private async rpc<Method extends TerminalDaemonRpcMethod>(
    method: Method,
    params: TerminalDaemonRpcParams<Method>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<TerminalDaemonRpcResult<Method>> {
    const requestId = randomUUID();
    const socket = this.connect({ mode: "rpc", requestId, method, params });
    const timeout = setTimeout(
      () =>
        socket.destroy(
          new TerminalServiceError(
            "terminal_daemon_timeout",
            503,
            "The terminal service did not respond in time.",
          ),
        ),
      timeoutMs,
    ).unref();
    try {
      for await (const frame of daemonFrames(socket)) {
        if (frame.kind !== TERMINAL_IPC_JSON_FRAME)
          throw new Error("Terminal daemon sent an unknown RPC frame");
        const response = decodeTerminalIpcJson(
          frame.payload,
        ) as TerminalDaemonRpcResponse;
        if (response.requestId !== requestId) continue;
        if (!response.ok) throw daemonError(response.error);
        return response.result as TerminalDaemonRpcResult<Method>;
      }
      throw connectionLost();
    } finally {
      clearTimeout(timeout);
      socket.destroy();
    }
  }
}
