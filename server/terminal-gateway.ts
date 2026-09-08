import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  decodeTerminalInputFrame,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_HISTORY_DAYS,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_PROFILE_ID_CHARS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_TITLE_CHARS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_HISTORY_DAYS,
  MIN_TERMINAL_ROWS,
  type TerminalClientControlMessage,
  type TerminalMutationMethod,
} from "../shared/terminal-contracts.js";
import { requestError } from "./request-error.js";
import type {
  TerminalAttachment,
  TerminalOperationService,
  TerminalService,
} from "./terminal-service.js";

const terminalOperationSchema = z
  .object({
    id: z.string().uuid(),
    epoch: z.string().uuid(),
  })
  .strict();

const terminalIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/u);
const terminalDimensionsSchema = {
  cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
};
const terminalListSchema = z.object({
  cwd: z.string().min(1).max(4_096).optional(),
});
const terminalCreateSchema = z
  .object({
    cwd: z.string().min(1).max(4_096),
    profileId: z.string().min(1).max(MAX_TERMINAL_PROFILE_ID_CHARS).optional(),
    cols: terminalDimensionsSchema.cols.optional(),
    rows: terminalDimensionsSchema.rows.optional(),
  })
  .strict();
const terminalRenameSchema = z
  .object({ title: z.string().max(MAX_TERMINAL_TITLE_CHARS).nullable() })
  .strict();
const terminalReorderSchema = z
  .object({
    cwd: z.string().min(1).max(4_096),
    terminalIds: z.array(terminalIdSchema).max(32),
  })
  .strict();
const terminalSettingsPatchSchema = z
  .object({
    persistOutput: z.boolean().optional(),
    historyRetentionDays: z
      .number()
      .int()
      .min(MIN_TERMINAL_HISTORY_DAYS)
      .max(MAX_TERMINAL_HISTORY_DAYS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const terminalAttachSchema = z
  .object({
    type: z.literal("attach"),
    ticket: z.string().uuid(),
    clientId: z.string().min(1).max(128),
    ...terminalDimensionsSchema,
    outputEpoch: z.string().min(1).max(80).optional(),
    nextOutputOffset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    resizeRevision: z.number().int().nonnegative().max(0xffffffff).optional(),
    ownerToken: z.string().min(1).max(128).optional(),
  })
  .strict();
const terminalControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resize"), ...terminalDimensionsSchema }).strict(),
  z
    .object({ type: z.literal("take_control"), ...terminalDimensionsSchema })
    .strict(),
  z.object({ type: z.literal("release_control") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

const TERMINAL_ATTACH_TICKET_TTL_MS = 15_000;
const MAX_TERMINAL_ATTACH_TICKETS = 2_048;
const MAX_TERMINAL_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_SOCKETS = 128;

/** Register after /api authentication. Upgrade admission remains in the Host:
 * exact-origin paired cookies are required before a single-use ticket is read.
 * This gateway owns only tickets/attachments; the daemon still owns the PTYs. */
export function createTerminalGateway(
  app: Express,
  service: TerminalService | undefined,
  heartbeatIntervalMs: number,
) {
  const terminalTickets = new Map<
    string,
    { terminalId: string; expiresAt: number }
  >();
  const pruneTerminalTickets = (now = Date.now()): void => {
    for (const [ticket, entry] of terminalTickets) {
      if (entry.expiresAt <= now) terminalTickets.delete(ticket);
    }
    while (terminalTickets.size >= MAX_TERMINAL_ATTACH_TICKETS) {
      const oldest = terminalTickets.keys().next().value;
      if (typeof oldest !== "string") break;
      terminalTickets.delete(oldest);
    }
  };
  const consumeTerminalTicket = (
    ticket: string,
  ): { terminalId: string } | null => {
    const now = Date.now();
    pruneTerminalTickets(now);
    const entry = terminalTickets.get(ticket);
    terminalTickets.delete(ticket);
    return entry && entry.expiresAt > now
      ? { terminalId: entry.terminalId }
      : null;
  };
  const requireTerminal = (): TerminalService => {
    if (!service)
      throw requestError("Terminal service is unavailable", 503, {
        code: "terminal_unavailable",
      });
    return service;
  };
  // Schema/auth-independent refusals before dispatch are definite. Once a
  // mutation reaches the daemon transport, default to unknown until a receipt.
  app.use(
    /^\/api\/(?:terminals(?:\/|$)|terminal-settings$|terminal-history$)/u,
    (request, response, next) => {
      const header = request.get("X-Terminal-Operation");
      if (header !== undefined && request.method !== "GET") {
        if (header.length > 256)
          throw requestError("Invalid terminal operation", 400);
        const operation = terminalOperationSchema.parse(JSON.parse(header));
        response.set("X-Terminal-Operation", operation.id);
        response.set("X-Terminal-Outcome", "rejected");
      }
      next();
    },
  );
  const operationService = (): TerminalOperationService => {
    const terminal = requireTerminal();
    if (
      !("operate" in terminal) ||
      typeof terminal.operate !== "function" ||
      !("operationEpoch" in terminal) ||
      typeof terminal.operationEpoch !== "function"
    )
      throw requestError("Terminal operation receipts are unavailable", 503, {
        code: "terminal_operations_unavailable",
      });
    return terminal as TerminalOperationService;
  };
  const mutate = async <T>(
    request: Request,
    response: Response,
    method: TerminalMutationMethod,
    params: unknown,
    legacy: () => Promise<T>,
  ): Promise<T> => {
    const header = request.get("X-Terminal-Operation");
    if (header === undefined) return legacy();
    if (header.length > 256)
      throw requestError("Invalid terminal operation", 400);
    const operation = terminalOperationSchema.parse(JSON.parse(header));
    response.set("X-Terminal-Operation", operation.id);
    response.set("X-Terminal-Outcome", "unknown");
    try {
      const result = await operationService().operate<T>(
        method,
        params,
        operation,
      );
      response.set("X-Terminal-Outcome", "completed");
      return result;
    } catch (error) {
      const { status, code } = error as { status?: number; code?: string };
      const unknown = [
        "terminal_operation_epoch_changed",
        "terminal_operation_expired",
        "terminal_operation_mismatch",
      ].includes(code ?? "");
      response.set(
        "X-Terminal-Outcome",
        !unknown && status && status >= 400 && status < 500
          ? "rejected"
          : "unknown",
      );
      throw error;
    }
  };
  app.get("/api/terminal-operations", async (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ epoch: await operationService().operationEpoch() });
  });
  app.get("/api/terminals", async (request, response) => {
    const { cwd } = terminalListSchema.parse(request.query);
    response.json(await requireTerminal().list(cwd));
  });
  app.post("/api/terminals", async (request, response) => {
    const body = terminalCreateSchema.parse(request.body);
    response
      .status(201)
      .json(
        await mutate(request, response, "create", { request: body }, () =>
          requireTerminal().create(body),
        ),
      );
  });
  app.get("/api/terminal-settings", async (_request, response) => {
    response.json(await requireTerminal().getSettings());
  });
  app.patch("/api/terminal-settings", async (request, response) => {
    const patch = terminalSettingsPatchSchema.parse(request.body);
    response.json(
      await mutate(request, response, "updateSettings", { patch }, () =>
        requireTerminal().updateSettings(patch),
      ),
    );
  });
  app.delete("/api/terminal-history", async (request, response) => {
    await mutate(request, response, "clearHistory", {}, () =>
      requireTerminal().clearHistory(),
    );
    response.status(204).end();
  });
  app.patch("/api/terminals/:id", async (request, response) => {
    const id = terminalIdSchema.parse(request.params.id);
    const body = terminalRenameSchema.parse(request.body);
    response.json(
      await mutate(request, response, "rename", { id, title: body.title }, () =>
        requireTerminal().rename(id, body),
      ),
    );
  });
  app.post("/api/terminals/reorder", async (request, response) => {
    const { cwd, terminalIds } = terminalReorderSchema.parse(request.body);
    response.json(
      await mutate(
        request,
        response,
        "reorder",
        { projectCwd: cwd, ids: terminalIds },
        () => requireTerminal().reorder(cwd, terminalIds),
      ),
    );
  });
  app.post("/api/terminals/:id/restart", async (request, response) => {
    const id = terminalIdSchema.parse(request.params.id);
    response.json(
      await mutate(request, response, "restart", { id }, () =>
        requireTerminal().restart(id),
      ),
    );
  });
  app.delete("/api/terminals/:id", async (request, response) => {
    const id = terminalIdSchema.parse(request.params.id);
    const force = request.query.force === "1";
    response.json(
      await mutate(request, response, "remove", { id, force }, () =>
        requireTerminal().remove(id, force),
      ),
    );
  });
  app.post("/api/terminals/:id/attach-ticket", async (request, response) => {
    const terminal = requireTerminal();
    const terminalId = terminalIdSchema.parse(request.params.id);
    const catalog = await terminal.list();
    if (!catalog.terminals.some((candidate) => candidate.id === terminalId))
      throw requestError("Terminal was not found", 404, {
        code: "terminal_not_found",
      });
    pruneTerminalTickets();
    const ticket = randomUUID();
    const expiresAt = Date.now() + TERMINAL_ATTACH_TICKET_TTL_MS;
    terminalTickets.set(ticket, { terminalId, expiresAt });
    response.json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
  });

  const terminalWebsocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TERMINAL_INPUT_BYTES + 5,
    perMessageDeflate: false,
  });
  const terminalSockets = new Set<WebSocket>();
  const terminalAttachments = new Map<WebSocket, TerminalAttachment>();
  const responsiveTerminalSockets = new Map<WebSocket, boolean>();
  const sendTerminalBounded = (
    socket: WebSocket,
    message: string | Uint8Array,
  ): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const bytes =
      typeof message === "string"
        ? Buffer.byteLength(message)
        : message.byteLength;
    if (socket.bufferedAmount + bytes > MAX_TERMINAL_SOCKET_BUFFERED_BYTES) {
      socket.close(1013, "Terminal client fell behind");
      return false;
    }
    try {
      socket.send(message, { binary: typeof message !== "string" });
      return true;
    } catch {
      socket.terminate();
      return false;
    }
  };
  const heartbeatMessage = JSON.stringify({ type: "heartbeat" });
  const heartbeatInterval = setInterval(() => {
    for (const socket of terminalSockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!responsiveTerminalSockets.get(socket)) {
        socket.terminate();
        continue;
      }
      responsiveTerminalSockets.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
        continue;
      }
      if (terminalAttachments.has(socket))
        sendTerminalBounded(socket, heartbeatMessage);
    }
  }, heartbeatIntervalMs);
  heartbeatInterval.unref();

  terminalWebsocket.on("connection", (socket) => {
    terminalSockets.add(socket);
    responsiveTerminalSockets.set(socket, true);
    let attachment: TerminalAttachment | null = null;
    let attaching = false;
    let closed = false;
    const attachTimeout = setTimeout(() => {
      if (!attachment && socket.readyState === WebSocket.OPEN)
        socket.close(1008, "Terminal attach timed out");
    }, TERMINAL_ATTACH_TICKET_TTL_MS);
    attachTimeout.unref();
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(attachTimeout);
      terminalSockets.delete(socket);
      responsiveTerminalSockets.delete(socket);
      terminalAttachments.delete(socket);
      attachment?.detach();
      attachment = null;
    };
    const sendError = (code: string, message: string, fatal: boolean): void => {
      sendTerminalBounded(
        socket,
        JSON.stringify({ type: "error", code, message, fatal }),
      );
    };
    const sink = {
      sendControl(message: unknown): void {
        if (!sendTerminalBounded(socket, JSON.stringify(message)))
          throw new Error("Terminal socket is not writable");
      },
      sendData(frame: Uint8Array): void {
        if (!sendTerminalBounded(socket, frame))
          throw new Error("Terminal socket is not writable");
      },
      close(code: number, reason: string): void {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      },
    };
    socket.on("pong", () => responsiveTerminalSockets.set(socket, true));
    socket.on("error", () => {
      close();
      socket.terminate();
    });
    socket.on("close", close);
    socket.on("message", (raw, isBinary) => {
      if (closed) return;
      if (!attachment) {
        if (attaching || isBinary) {
          sendError(
            "terminal_attach_required",
            "Attach before using the terminal",
            true,
          );
          socket.close(1008, "Terminal attach required");
          return;
        }
        let request: z.infer<typeof terminalAttachSchema>;
        try {
          request = terminalAttachSchema.parse(
            JSON.parse(Buffer.from(raw as ArrayBuffer).toString("utf8")),
          );
        } catch {
          sendError(
            "invalid_terminal_attach",
            "Terminal attach is invalid",
            true,
          );
          socket.close(1008, "Invalid terminal attach");
          return;
        }
        const ticket = consumeTerminalTicket(request.ticket);
        if (!ticket) {
          sendError(
            "terminal_ticket_invalid",
            "Terminal attach ticket is invalid or expired",
            true,
          );
          socket.close(1008, "Invalid terminal ticket");
          return;
        }
        attaching = true;
        clearTimeout(attachTimeout);
        const { ticket: _ticket, type: _type, ...options } = request;
        void requireTerminal()
          .attach({ ...options, terminalId: ticket.terminalId }, sink)
          .then((handle) => {
            attaching = false;
            if (closed) handle.detach();
            else {
              attachment = handle;
              terminalAttachments.set(socket, handle);
            }
          })
          .catch((error: unknown) => {
            attaching = false;
            const code =
              typeof (error as { code?: unknown })?.code === "string"
                ? String((error as { code: string }).code)
                : "terminal_attach_failed";
            const message =
              error instanceof Error ? error.message : "Terminal attach failed";
            sendError(code, message, true);
            if (socket.readyState === WebSocket.OPEN)
              socket.close(1011, "Terminal attach failed");
          });
        return;
      }
      try {
        if (isBinary) {
          const frame = decodeTerminalInputFrame(
            Buffer.from(raw as ArrayBuffer),
          );
          attachment.writeInput(frame.sequence, frame.data);
        } else {
          const message = terminalControlSchema.parse(
            JSON.parse(Buffer.from(raw as ArrayBuffer).toString("utf8")),
          ) as Exclude<TerminalClientControlMessage, { type: "attach" }>;
          attachment.control(message);
        }
      } catch (error) {
        sendError(
          "invalid_terminal_message",
          error instanceof Error
            ? error.message
            : "Terminal message is invalid",
          true,
        );
        socket.close(1008, "Invalid terminal message");
      }
    });
  });

  return {
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (terminalSockets.size >= MAX_TERMINAL_SOCKETS) {
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      terminalWebsocket.handleUpgrade(request, socket, head, (client) => {
        terminalWebsocket.emit("connection", client, request);
      });
    },
    close(): void {
      clearInterval(heartbeatInterval);
      terminalTickets.clear();
      for (const socket of terminalSockets)
        socket.close(1001, "Server shutting down");
    },
  };
}
