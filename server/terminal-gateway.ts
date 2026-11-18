import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { BROWSER_UPGRADE_CLOSE } from "../shared/browser-build.mjs";
import { hostEndpoints as routes } from "../shared/host-endpoints.js";
import { MAX_TERMINAL_INPUT_BYTES } from "../shared/terminal-contracts.js";
import {
  TERMINAL_OPERATIONS_PATH,
  terminalAttachTicketSchema,
  terminalOperationIdentitySchema,
  terminalOperationSchema,
  terminalReceiptIdentity,
} from "../shared/terminal-operations.js";
import { canonicalOrigin } from "./browser-auth.js";
import { maintainBrowserSockets, terminateUpgradedSockets } from "./browser-socket-lifecycle.js";
import { jsonRoute } from "./json-route.js";
import { settleOperation } from "./operation-receipts.js";
import { requestError } from "./request-error.js";
import { terminalDaemonMethods } from "./terminal-daemon-protocol.js";
import {
  type TerminalAttachment,
  type TerminalConnection,
  type TerminalService,
} from "./terminal-service.js";

const TERMINAL_ATTACH_TICKET_TTL_MS = 15_000;
const MAX_TERMINAL_ATTACH_TICKETS = 2_048;
const MAX_TERMINAL_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_SOCKETS = 128;

interface TerminalSocketState {
  responsive: boolean;
  attachment: TerminalAttachment | "attaching" | null;
  browserBuild: string | undefined;
  detach(): void;
}

/** Register after /api authentication. Upgrade admission remains in the Host:
 * exact-origin single-use socket tickets are required before attach is read.
 * This gateway owns only tickets/attachments; the daemon still owns the PTYs. */
export function createTerminalGateway(
  app: Express,
  service: TerminalService | Pick<TerminalConnection, "run"> | undefined,
  heartbeatIntervalMs: number,
  currentBrowserBuild: () => Promise<string | undefined>,
) {
  const terminalTickets = new Map<
    string,
    { terminalId: string; origin: string; expiresAt: number }
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
    origin: string | undefined,
  ): { terminalId: string } | null => {
    const now = Date.now();
    pruneTerminalTickets(now);
    const entry = terminalTickets.get(ticket);
    terminalTickets.delete(ticket);
    return entry && entry.expiresAt > now && entry.origin === origin
      ? { terminalId: entry.terminalId }
      : null;
  };
  const terminal = async <Result>(
    operation: (service: TerminalService) => Result | Promise<Result>,
  ): Promise<Result> => {
    if (!service)
      throw requestError("Terminal service is unavailable", 503, {
        code: "terminal_unavailable",
      });
    return "run" in service ? service.run(operation) : operation(service);
  };
  app.get(TERMINAL_OPERATIONS_PATH, async (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({
      epoch: (await terminal(terminalDaemonMethods.ping)).operationEpoch,
    });
  });
  app.post(TERMINAL_OPERATIONS_PATH, async (request, response) => {
    const observeOnly = request.query.observe === "1";
    const identity = terminalOperationIdentitySchema.parse(request.body);
    const parsed = terminalOperationSchema.safeParse(request.body);
    const command = request.body?.intent?.command;
    if (!parsed.success) {
      if (typeof command !== "string") throw parsed.error;
      response.status(400).json({
        ...identity,
        command,
        state: observeOnly ? "unknown" : "rejected",
        error: { status: 400, message: "The terminal operation is invalid." },
      });
      return;
    }
    const { data: operation } = parsed;
    const receipt = await settleOperation(
      terminalReceiptIdentity(operation),
      async () =>
        (await terminal((service) =>
          terminalDaemonMethods[observeOnly ? "observeOperation" : "operate"](
            service, operation,
          ),
        )) ?? null,
      ({ code, status }) =>
        status < 400 ||
        status >= 500 ||
        [
          "terminal_operation_epoch_changed",
          "terminal_operation_expired",
          "terminal_operation_missing",
          "terminal_operation_mismatch",
        ].includes(code ?? ""),
      "Terminal operation failed.",
    );
    if (receipt.state === "rejected" || receipt.state === "unknown")
      response.status(receipt.error.status);
    response.json(receipt);
  });
  jsonRoute(app, routes.terminals, ({ query }) =>
    terminal((service) =>
      terminalDaemonMethods.getCatalog(service, { projectCwd: query.cwd }),
    ),
  );
  jsonRoute(app, routes.terminalSettings, () =>
    terminal(terminalDaemonMethods.getSettings),
  );
  jsonRoute(
    app,
    routes.terminalAttachTicket,
    async ({ params: { id: terminalId } }, request) => {
      const catalog = await terminal((service) => terminalDaemonMethods.getCatalog(service, {}));
      if (!catalog.terminals.some((candidate) => candidate.id === terminalId))
        throw requestError("Terminal was not found", 404, {
          code: "terminal_not_found",
        });
      pruneTerminalTickets();
      const ticket = randomUUID();
      const expiresAt = Date.now() + TERMINAL_ATTACH_TICKET_TTL_MS;
      terminalTickets.set(ticket, {
        terminalId,
        origin: canonicalOrigin(request.get("host"), request.secure),
        expiresAt,
      });
      return { ticket, expiresAt: new Date(expiresAt).toISOString() };
    },
  );

  const terminalWebsocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TERMINAL_INPUT_BYTES + 5,
    perMessageDeflate: false,
  });
  const terminalSockets = new Map<WebSocket, TerminalSocketState>();
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
  const stopHeartbeat = maintainBrowserSockets(
    terminalSockets, heartbeatIntervalMs, currentBrowserBuild,
    (peer) => !!peer.attachment && peer.attachment !== "attaching",
    sendTerminalBounded, (socket) => terminalSockets.get(socket)?.detach(),
  );

  function openTerminalSocket(
    socket: WebSocket,
    origin: string | undefined,
    build: string | undefined,
  ): void {
    const peer: TerminalSocketState = {
      responsive: true,
      attachment: null,
      browserBuild: build,
      detach,
    };
    terminalSockets.set(socket, peer);
    const attachTimeout = setTimeout(() => {
      if (!peer.attachment && socket.readyState === WebSocket.OPEN)
        socket.close(1008, "Terminal attach timed out");
    }, TERMINAL_ATTACH_TICKET_TTL_MS);
    attachTimeout.unref();
    function detach(): void {
      if (!terminalSockets.delete(socket)) return;
      clearTimeout(attachTimeout);
      if (peer.attachment && peer.attachment !== "attaching")
        peer.attachment.detach();
    }
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
    socket.on("pong", () => {
      peer.responsive = true;
    });
    socket.on("error", () => {
      detach();
      socket.terminate();
    });
    socket.on("close", detach);
    socket.on("message", (raw, isBinary) => {
      if (!terminalSockets.has(socket)) return;
      const attachment = peer.attachment;
      if (!attachment || attachment === "attaching") {
        if (attachment === "attaching" || isBinary) {
          sendError(
            "terminal_attach_required",
            "Attach before using the terminal",
            true,
          );
          socket.close(1008, "Terminal attach required");
          return;
        }
        let request: ReturnType<typeof terminalAttachTicketSchema.parse>;
        try {
          request = terminalAttachTicketSchema.parse(
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
        const ticket = consumeTerminalTicket(request.ticket, origin);
        if (!ticket) {
          sendError(
            "terminal_ticket_invalid",
            "Terminal attach ticket is invalid or expired",
            true,
          );
          socket.close(1008, "Invalid terminal ticket");
          return;
        }
        peer.attachment = "attaching";
        clearTimeout(attachTimeout);
        const { ticket: _ticket, type: _type, ...options } = request;
        void terminal((service) =>
          service.attach({ ...options, terminalId: ticket.terminalId }, sink),
        )
          .then((handle) => {
            if (terminalSockets.has(socket)) peer.attachment = handle;
            else handle.detach();
          })
          .catch((error: unknown) => {
            peer.attachment = null;
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
        const data = Buffer.from(raw as ArrayBuffer);
        if (isBinary) {
          attachment.send({ data });
        } else {
          const control = JSON.parse(data.toString("utf8"));
          if (control?.type === "terminal_daemon_detach")
            throw new Error("Terminal message is invalid");
          attachment.send({ control });
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
  }

  return {
    rejectUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void {
      terminalWebsocket.handleUpgrade(request, socket, head, (client) =>
        client.close(BROWSER_UPGRADE_CLOSE, "Reload Inspire"),
      );
    },
    upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      build: string | undefined,
    ): void {
      if (terminalSockets.size >= MAX_TERMINAL_SOCKETS) {
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      terminalWebsocket.handleUpgrade(request, socket, head, (client) => {
        openTerminalSocket(client, request.headers.origin, build);
      });
    },
    close(): void {
      stopHeartbeat();
      terminalTickets.clear();
      for (const socket of terminalSockets.keys())
        socket.close(1001, "Server shutting down");
    },
    terminateRemaining: () => terminateUpgradedSockets(terminalWebsocket),
  };
}
