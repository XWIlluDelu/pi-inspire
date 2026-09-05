import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  encodeTerminalInputFrame,
  type TerminalCatalogResponse,
  type TerminalClientControlMessage,
  type TerminalCreateRequest,
  type TerminalDescriptor,
  type TerminalRemoveResponse,
  type TerminalRenameRequest,
  type TerminalServerControlMessage,
  type TerminalServiceSettings,
  type TerminalServiceSettingsPatch,
} from "../shared/terminal-contracts.js";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_READY_TYPE,
  TERMINAL_DAEMON_REPLACING_TYPE,
  type TerminalDaemonRpcMethod,
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
} from "./terminal-ipc.js";
import type {
  TerminalAttachment,
  TerminalAttachmentSink,
  TerminalAttachOptions,
  TerminalService,
} from "./terminal-service.js";
import { TerminalServiceError } from "./terminal-service.js";

const RPC_TIMEOUT_MS = 5_000;
// A lifecycle mutation may need graceful stop, process-tree termination and
// PTY output drain before the daemon can acknowledge the result.
const LIFECYCLE_RPC_TIMEOUT_MS = 15_000;
const ATTACH_TIMEOUT_MS = 30_000;
const IPC_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

function socketChunkBytes(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
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

class DaemonAttachment implements TerminalAttachment {
  private detached = false;

  constructor(
    readonly id: string,
    readonly terminalId: string,
    private readonly socket: Socket,
    private readonly onDetach: () => void,
  ) {}

  writeInput(sequence: number, data: Uint8Array): void {
    this.write(
      TERMINAL_IPC_INPUT_FRAME,
      encodeTerminalInputFrame(sequence, data),
    );
  }

  control(
    message: Exclude<TerminalClientControlMessage, { type: "attach" }>,
  ): void {
    this.write(TERMINAL_IPC_JSON_FRAME, JSON.stringify(message));
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.onDetach();
    if (!this.socket.destroyed) {
      this.socket.end(
        encodeTerminalIpcJson({ type: "terminal_daemon_detach" }),
      );
    }
  }

  private write(kind: number, payload: string | Uint8Array): void {
    if (this.detached || this.socket.destroyed)
      throw new Error("Terminal attachment is disconnected");
    const frame = encodeTerminalIpcFrame(kind, payload);
    if (
      this.socket.writableLength + frame.byteLength >
      IPC_BUFFER_LIMIT_BYTES
    ) {
      this.socket.destroy();
      throw new Error("Terminal attachment is too slow");
    }
    this.socket.write(frame);
  }
}

export class TerminalDaemonClient implements TerminalService {
  private readonly attachments = new Set<DaemonAttachment>();
  private closed = false;

  constructor(
    private readonly address: string,
    private readonly token: string,
  ) {}

  async probe(): Promise<void> {
    await this.rpc("ping", {});
  }

  /** Ask an authenticated older daemon to leave its IPC address so this
   * launcher can start a wire-compatible version. A matching daemon refuses. */
  requestProtocolReplacement(
    protocolVersion = TERMINAL_DAEMON_PROTOCOL_VERSION,
  ): Promise<boolean> {
    return new Promise<boolean>((resolvePromise) => {
      const socket = createConnection(this.address);
      const decoder = new TerminalIpcDecoder();
      let settled = false;
      const finish = (replacing: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolvePromise(replacing);
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        finish(false);
      }, 1_000);
      timeout.unref?.();
      socket.once("connect", () => {
        socket.write(
          encodeTerminalIpcJson({
            protocolVersion,
            mode: "replace",
            token: this.token,
          }),
        );
      });
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(socketChunkBytes(chunk))) {
            if (frame.kind !== TERMINAL_IPC_JSON_FRAME) continue;
            const message = asRecord(decodeTerminalIpcJson(frame.payload));
            if (message?.type === TERMINAL_DAEMON_REPLACING_TYPE) {
              finish(true);
              socket.end();
            }
          }
        } catch {
          socket.destroy();
          finish(false);
        }
      });
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
    });
  }

  list(projectCwd?: string): Promise<TerminalCatalogResponse> {
    return projectCwd === undefined
      ? this.rpc("getGlobalCatalog", {})
      : this.rpc("getCatalog", { projectCwd });
  }

  create(request: TerminalCreateRequest): Promise<TerminalDescriptor> {
    return this.rpc("create", { request });
  }

  rename(
    id: string,
    request: TerminalRenameRequest,
  ): Promise<TerminalDescriptor> {
    return this.rpc("rename", { id, title: request.title });
  }

  reorder(projectCwd: string, ids: string[]): Promise<TerminalCatalogResponse> {
    return this.rpc("reorder", { projectCwd, ids });
  }

  restart(id: string): Promise<TerminalDescriptor> {
    return this.rpc("restart", { id });
  }

  remove(id: string, force: boolean): Promise<TerminalRemoveResponse> {
    return this.rpc("remove", { id, force });
  }

  getSettings(): Promise<TerminalServiceSettings> {
    return this.rpc("getSettings", {});
  }

  updateSettings(
    patch: TerminalServiceSettingsPatch,
  ): Promise<TerminalServiceSettings> {
    return this.rpc("updateSettings", { patch });
  }

  async clearHistory(): Promise<void> {
    await this.rpc("clearHistory", {});
  }

  attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    if (this.closed)
      return Promise.reject(
        new TerminalServiceError(
          "terminal_service_closed",
          503,
          "The terminal service is stopping.",
        ),
      );

    return new Promise<TerminalAttachment>((resolvePromise, rejectPromise) => {
      const socket = createConnection(this.address);
      socket.setNoDelay(true);
      const decoder = new TerminalIpcDecoder();
      let settled = false;
      let failed = false;
      let intentionalClose = false;
      let deliveryReady = false;
      let attachment: DaemonAttachment | null = null;
      let attachTimeout: ReturnType<typeof setTimeout> | null = null;
      const pendingDeliveries: Array<() => void> = [];

      const fail = (error: unknown): void => {
        if (failed) return;
        failed = true;
        pendingDeliveries.length = 0;
        if (attachTimeout) clearTimeout(attachTimeout);
        attachTimeout = null;
        if (!settled) {
          settled = true;
          rejectPromise(error);
          return;
        }
        if (!intentionalClose) {
          try {
            sink.close(1012, "Terminal service connection lost");
          } catch {
            // The browser-side transport may already be gone.
          }
        }
      };
      const deliver = (operation: () => void): void => {
        if (!deliveryReady) {
          pendingDeliveries.push(operation);
          return;
        }
        operation();
      };
      const establishAttachment = (): void => {
        if (settled) return;
        attachment = new DaemonAttachment(
          randomUUID(),
          options.terminalId,
          socket,
          () => {
            intentionalClose = true;
            if (attachment) this.attachments.delete(attachment);
          },
        );
        this.attachments.add(attachment);
        settled = true;
        resolvePromise(attachment);
        // Promise reactions run before this microtask. That lets the Host
        // publish the attachment handle before replay_complete can cause a
        // fast browser to send its first input frame.
        queueMicrotask(() => {
          if (failed || intentionalClose) {
            pendingDeliveries.length = 0;
            return;
          }
          deliveryReady = true;
          try {
            for (const operation of pendingDeliveries.splice(0)) operation();
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

      socket.once("connect", () => {
        socket.write(
          encodeTerminalIpcJson({
            protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
            mode: "attach",
            token: this.token,
            terminalId: options.terminalId,
            options,
          }),
        );
      });
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(socketChunkBytes(chunk))) {
            if (frame.kind === TERMINAL_IPC_DATA_FRAME) {
              if (!settled)
                throw new Error("Terminal daemon sent output before attaching");
              deliver(() => sink.sendData(frame.payload));
              continue;
            }
            if (frame.kind !== TERMINAL_IPC_JSON_FRAME)
              throw new Error("Terminal daemon sent an unknown IPC frame");
            const message = asRecord(decodeTerminalIpcJson(frame.payload));
            if (message?.type === TERMINAL_DAEMON_READY_TYPE) {
              if (!settled)
                throw new Error(
                  "Terminal daemon became ready before identifying the attachment",
                );
              if (attachTimeout) clearTimeout(attachTimeout);
              attachTimeout = null;
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
              deliver(() => {
                intentionalClose = true;
                sink.close(code, reason);
                socket.end();
              });
              continue;
            }
            if (message?.type === "attached") establishAttachment();
            if (!settled)
              throw new Error(
                "Terminal daemon did not identify the attachment",
              );
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
        fail(
          new TerminalServiceError(
            "terminal_daemon_unavailable",
            503,
            "The terminal service is unavailable.",
          ),
        );
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const attachment of [...this.attachments]) attachment.detach();
    this.attachments.clear();
  }

  private rpc<Result>(
    method: TerminalDaemonRpcMethod,
    params: unknown,
  ): Promise<Result> {
    if (this.closed)
      return Promise.reject(
        new TerminalServiceError(
          "terminal_service_closed",
          503,
          "The terminal service is stopping.",
        ),
      );
    return new Promise<Result>((resolvePromise, rejectPromise) => {
      const socket = createConnection(this.address);
      const decoder = new TerminalIpcDecoder();
      const requestId = randomUUID();
      let settled = false;
      const timeout = setTimeout(
        () => {
          finish(
            new TerminalServiceError(
              "terminal_daemon_timeout",
              503,
              "The terminal service did not respond in time.",
            ),
          );
          socket.destroy();
        },
        method === "remove" || method === "restart"
          ? LIFECYCLE_RPC_TIMEOUT_MS
          : RPC_TIMEOUT_MS,
      );
      timeout.unref?.();

      const finish = (error?: unknown, result?: Result): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectPromise(error);
        else resolvePromise(result as Result);
      };

      socket.once("connect", () => {
        socket.write(
          encodeTerminalIpcJson({
            protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
            mode: "rpc",
            token: this.token,
            requestId,
            method,
            params,
          }),
        );
      });
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(socketChunkBytes(chunk))) {
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
        finish(
          new TerminalServiceError(
            "terminal_daemon_unavailable",
            503,
            "The terminal service is unavailable.",
          ),
        );
      });
    });
  }
}
