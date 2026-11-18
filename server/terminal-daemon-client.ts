import { randomUUID } from "node:crypto";
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
} from "./terminal-ipc.js";
import type {
  TerminalAttachment,
  TerminalAttachmentSink,
  TerminalClientFrame,
  TerminalService,
} from "./terminal-service.js";
import { TerminalServiceError } from "./terminal-service.js";

const RPC_TIMEOUT_MS = 5_000;
// A lifecycle mutation may need graceful stop, process-tree termination and
// PTY output drain before the daemon can acknowledge the result.
const LIFECYCLE_RPC_TIMEOUT_MS = 15_000;
const ATTACH_TIMEOUT_MS = 30_000;
const IPC_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

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

  attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    return new Promise<TerminalAttachment>((resolvePromise, rejectPromise) => {
      const socket = this.connect({ mode: "attach", options });
      socket.setNoDelay(true);
      const decoder = new TerminalIpcDecoder();
      let state: "connecting" | "publishing" | "ready" | "closed" = "connecting";
      let attachment: TerminalAttachment | null = null;
      let attachTimeout: ReturnType<typeof setTimeout> | null = null;
      const pendingDeliveries: Array<() => void> = [];

      const clearDeadline = () => {
        if (attachTimeout) clearTimeout(attachTimeout);
        attachTimeout = null;
      };
      const fail = (error: unknown): void => {
        if (state === "closed") return;
        const connecting = state === "connecting";
        state = "closed";
        pendingDeliveries.length = 0;
        clearDeadline();
        if (connecting) rejectPromise(error);
        else {
          try {
            sink.close(1012, "Terminal service connection lost");
          } catch {
            // The browser may already be gone.
          }
        }
      };
      const deliver = (operation: () => void): void => {
        if (state === "publishing") pendingDeliveries.push(operation);
        else if (state === "ready") operation();
      };
      const establishAttachment = (): void => {
        if (state !== "connecting") return;
        if (this.closed) throw serviceStopping();
        const handle: TerminalAttachment = {
          send(frame: TerminalClientFrame) {
            if (state === "closed" || socket.destroyed)
              throw new Error("Terminal attachment is disconnected");
            const packet =
              "data" in frame
                ? encodeTerminalIpcFrame(TERMINAL_IPC_INPUT_FRAME, frame.data)
                : encodeTerminalIpcJson(frame.control);
            if (socket.writableLength + packet.byteLength > IPC_BUFFER_LIMIT_BYTES) {
              socket.destroy();
              throw new Error("Terminal attachment is too slow");
            }
            socket.write(packet);
          },
          detach: () => {
            if (state === "closed") return;
            state = "closed";
            clearDeadline();
            this.attachments.delete(handle);
            if (!socket.destroyed)
              socket.end(encodeTerminalIpcJson({ type: "terminal_daemon_detach" }));
          },
        };
        attachment = handle;
        this.attachments.add(handle);
        state = "publishing";
        resolvePromise(handle);
        // Promise reactions run before this microtask. That lets the Host
        // publish the attachment handle before replay_complete can cause a
        // fast browser to send its first input frame.
        queueMicrotask(() => {
          if (state !== "publishing") {
            pendingDeliveries.length = 0;
            return;
          }
          state = "ready";
          try {
            for (const operation of pendingDeliveries.splice(0)) deliver(operation);
          } catch (error) {
            fail(error);
            socket.destroy();
          }
        });
      };
      attachTimeout = setTimeout(() => {
        fail(new Error("Terminal daemon attach timed out"));
        socket.destroy();
      }, ATTACH_TIMEOUT_MS);
      attachTimeout.unref();

      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind === TERMINAL_IPC_DATA_FRAME) {
              if (state === "connecting")
                throw new Error("Terminal daemon sent output before attaching");
              deliver(() => sink.sendData(frame.payload));
              continue;
            }
            if (frame.kind !== TERMINAL_IPC_JSON_FRAME)
              throw new Error("Terminal daemon sent an unknown IPC frame");
            const message = asRecord(decodeTerminalIpcJson(frame.payload));
            if (message?.type === TERMINAL_DAEMON_READY_TYPE) {
              if (state === "connecting")
                throw new Error("Terminal daemon did not identify the attachment");
              clearDeadline();
              continue;
            }
            if (message?.type === "terminal_daemon_error") {
              const error = daemonError(message.error);
              fail(error);
              socket.destroy();
              continue;
            }
            if (message?.type === "terminal_daemon_close") {
              const code =
                typeof message.code === "number" ? message.code : 1012;
              const reason =
                typeof message.reason === "string"
                  ? message.reason
                  : "Terminal closed";
              if (state === "connecting")
                throw new TerminalServiceError("terminal_attach_failed", 503, reason);
              deliver(() => {
                state = "closed";
                clearDeadline();
                try {
                  sink.close(code, reason);
                } finally {
                  socket.end();
                }
              });
              continue;
            }
            if (message?.type === "attached") establishAttachment();
            if (attachment === null && state !== "closed")
              throw new Error("Terminal daemon did not identify the attachment");
            deliver(() =>
              sink.sendControl(
                message as unknown as TerminalServerControlMessage,
              ),
            );
          }
        } catch (error) {
          fail(error);
          socket.destroy();
        }
      });
      socket.once("error", (error) => fail(error));
      socket.once("close", () => {
        if (attachment) this.attachments.delete(attachment);
        fail(connectionLost());
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const attachment of [...this.attachments]) attachment.detach();
    this.attachments.clear();
  }

  private rpc<Method extends TerminalDaemonRpcMethod>(
    method: Method,
    params: TerminalDaemonRpcParams<Method>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<TerminalDaemonRpcResult<Method>> {
    type Result = TerminalDaemonRpcResult<Method>;
    return new Promise<Result>((resolvePromise, rejectPromise) => {
      const requestId = randomUUID();
      const socket = this.connect({ mode: "rpc", requestId, method, params });
      const decoder = new TerminalIpcDecoder();
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          new TerminalServiceError(
            "terminal_daemon_timeout",
            503,
            "The terminal service did not respond in time.",
          ),
        );
        socket.destroy();
      }, timeoutMs);
      timeout.unref();

      const finish = (error?: unknown, result?: Result): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectPromise(error);
        else resolvePromise(result as Result);
      };

      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind !== TERMINAL_IPC_JSON_FRAME)
              throw new Error("Terminal daemon sent an unknown RPC frame");
            const response = decodeTerminalIpcJson(
              frame.payload,
            ) as TerminalDaemonRpcResponse;
            if (response.requestId !== requestId) continue;
            if (!response.ok) finish(daemonError(response.error));
            else finish(undefined, response.result as Result);
            socket.end();
          }
        } catch (error) {
          finish(error);
          socket.destroy();
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => {
        finish(connectionLost());
      });
    });
  }
}
