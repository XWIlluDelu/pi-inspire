import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { WebSocket, WebSocketServer } from "ws";
import { z, ZodError } from "zod";
import {
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  THINKING_LEVELS,
  type BootstrapResponse,
} from "../shared/contracts.js";
import type { AttachmentStore } from "./attachments.js";
import { listHostDirectories } from "./host-dirs.js";
import type { PreferencesStore } from "./preferences.js";
import { listProjectDirectory, searchProjectFiles } from "./project-files.js";
import type { ResourceStore } from "./resources.js";
import type { RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike } from "./session-catalog.js";

const openSchema = z.object({ id: z.string().min(1).max(128) });
const newSchema = z.object({ cwd: z.string().min(1).max(4_096), name: z.string().max(160).optional() });
const sessionIdField = z.string().min(1).max(200);
const promptSchema = z.object({
  sessionId: sessionIdField,
  message: z.string().max(500_000),
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
  projectFiles: z.array(z.string().max(4_096)).max(MAX_PROJECT_FILES).optional(),
  behavior: z.enum(["steer", "followUp"]).optional(),
});
const abortSchema = z.object({ sessionId: sessionIdField });
const renameSchema = z.object({ sessionId: sessionIdField, name: z.string().max(160) });
const modelSchema = z.object({
  sessionId: sessionIdField,
  provider: z.string().min(1).max(120),
  modelId: z.string().min(1).max(240),
});
const thinkingSchema = z.object({ sessionId: sessionIdField, level: z.enum(THINKING_LEVELS) });
const extensionSchema = z.object({
  sessionId: sessionIdField,
  id: z.string().min(1).max(200),
}).passthrough();
const sessionQuerySchema = z.object({
  q: z.string().max(200).default(""),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
const fileQuerySchema = z.object({
  sessionId: sessionIdField,
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const fileListSchema = z.object({
  sessionId: sessionIdField,
  dir: z
    .string()
    .max(4_096)
    .default("")
    .refine((value) => !value.split("/").includes(".."), "dir must stay inside the project"),
});
const hostDirsSchema = z.object({
  path: z.string().min(1).max(4_096).refine(isAbsolute, "path must be absolute").optional(),
});
const sessionIdsSchema = z.object({ ids: z.array(z.string().min(1).max(128)).max(100) });
const pinSchema = z.object({ id: z.string().min(1).max(128), pinned: z.boolean() });
const attachmentIdSchema = z.string().uuid();
const resourceResolveSchema = z.object({
  sessionId: sessionIdField,
  reference: z.string().min(1).max(8_192),
});
const resourceContentSchema = z.object({ sessionId: sessionIdField });

export const MAX_JOINING_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;

export interface AppDependencies {
  token: string;
  runtime: RuntimeLike;
  catalog: SessionCatalogLike;
  attachments: AttachmentStore;
  preferences: PreferencesStore;
  resources: ResourceStore;
  mock: boolean;
  version: string;
  piVersion: string;
  distDir?: string;
}

function bearerToken(request: Request): string | undefined {
  const value = request.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host === host;
  } catch {
    return false;
  }
}

/** This endpoint deliberately supports one byte range. Express owns RFC
 * parsing (including suffix and open-ended forms); malformed, unsatisfiable,
 * non-byte, and multi-range requests fail rather than unexpectedly receiving
 * the whole potentially large resource. */
function resourceByteRange(request: Request, size: number): { start: number; end: number } | null {
  if (!request.get("range")) return null;
  const ranges = request.range(size);
  if (!Array.isArray(ranges) || ranges.type !== "bytes" || ranges.length !== 1) {
    throw Object.assign(new Error("The requested byte range cannot be served"), { status: 416 });
  }
  return ranges[0]!;
}

function apiError(error: unknown, request: Request, response: Response, _next: NextFunction): void {
  const status =
    error instanceof ZodError
      ? 400
      : error instanceof multer.MulterError
        ? error.code === "LIMIT_FILE_SIZE"
          ? 413
          : 400
        : Number((error as { status?: unknown })?.status) || 500;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (status >= 500) console.error(`[${request.method} ${request.path}]`, error);
  response.status(status).json({ error: message });
}

export function createInspireServer(deps: AppDependencies): { app: express.Express; server: Server; close: () => Promise<void> } {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        // Remote images stay out: untrusted transcript content must not be
        // able to fire network requests just by being rendered.
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join("; "),
    });
    if (request.path.startsWith("/api/")) response.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", (request, response, next) => {
    if (!originAllowed(request.get("origin"), request.get("host"))) {
      return response.status(403).json({ error: "Origin is not allowed" });
    }
    if (bearerToken(request) !== deps.token) return response.status(401).json({ error: "Authentication required" });
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ appName: "insπre", mock: deps.mock });
  });

  app.get("/api/bootstrap", async (_request, response) => {
    const body: BootstrapResponse = {
      appName: "insπre",
      version: deps.version,
      piVersion: deps.piVersion,
      mock: deps.mock,
      preferences: await deps.preferences.read(),
      snapshot: await deps.runtime.snapshot(),
    };
    response.json(body);
  });

  app.get("/api/sessions", async (request, response) => {
    const { q, offset, limit } = sessionQuerySchema.parse(request.query);
    response.json(await deps.catalog.list({ query: q, offset, limit }));
  });
  app.post("/api/sessions/refresh", async (_request, response) => {
    await deps.catalog.refresh(true);
    response.json({ ok: true });
  });
  app.post("/api/sessions/by-id", async (request, response) => {
    const { ids } = sessionIdsSchema.parse(request.body);
    response.json({ sessions: await deps.catalog.listByIds(ids) });
  });
  app.post("/api/sessions/pin", async (request, response) => {
    const { id, pinned } = pinSchema.parse(request.body);
    if (!(await deps.catalog.get(id))) return response.status(404).json({ error: "Session not found" });
    const preferences = await deps.preferences.update((current) => ({
      ...current,
      pinnedSessionIds: pinned
        ? [id, ...current.pinnedSessionIds.filter((candidate) => candidate !== id)]
        : current.pinnedSessionIds.filter((candidate) => candidate !== id),
    }));
    response.json(preferences);
  });
  app.post("/api/sessions/open", async (request, response) => {
    const { id } = openSchema.parse(request.body);
    response.json(await deps.runtime.openSession(id));
  });
  app.post("/api/sessions/new", async (request, response) => {
    const { cwd, name } = newSchema.parse(request.body);
    response.json(await deps.runtime.newSession(cwd, name));
  });
  app.post("/api/sessions/rename", async (request, response) => {
    const { sessionId, name } = renameSchema.parse(request.body);
    await deps.runtime.rename(sessionId, name);
    response.json({ ok: true });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024, files: MAX_ATTACHMENTS, fields: MAX_ATTACHMENTS },
  });
  app.post("/api/attachments", upload.array("files", MAX_ATTACHMENTS), async (request, response) => {
    const files = Array.isArray(request.files) ? request.files : [];
    if (files.length === 0) return response.status(400).json({ error: "No files provided" });
    response.json({ attachments: await Promise.all(files.map((file) => deps.attachments.add(file))) });
  });
  app.delete("/api/attachments/:id", async (request, response) => {
    await deps.attachments.remove(attachmentIdSchema.parse(request.params.id));
    response.json({ ok: true });
  });

  app.post("/api/prompt", async (request, response) => {
    await deps.runtime.prompt(promptSchema.parse(request.body));
    response.status(202).json({ accepted: true });
  });
  app.post("/api/control/abort", async (request, response) => {
    const { sessionId } = abortSchema.parse(request.body);
    await deps.runtime.abort(sessionId);
    response.json({ ok: true });
  });
  app.post("/api/control/model", async (request, response) => {
    const value = modelSchema.parse(request.body);
    response.json(await deps.runtime.setModel(value.sessionId, value.provider, value.modelId));
  });
  app.post("/api/control/thinking", async (request, response) => {
    const { sessionId, level } = thinkingSchema.parse(request.body);
    await deps.runtime.setThinkingLevel(sessionId, level);
    response.json({ ok: true });
  });
  app.post("/api/extension-ui", async (request, response) => {
    await deps.runtime.extensionUiResponse(extensionSchema.parse(request.body));
    response.json({ ok: true });
  });

  app.get("/api/files", async (request, response) => {
    const { sessionId, q, limit } = fileQuerySchema.parse(request.query);
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd) return response.status(409).json({ error: "That session is not open on this host" });
    response.json({ files: await searchProjectFiles(cwd, q, limit) });
  });
  app.get("/api/files/list", async (request, response) => {
    const { sessionId, dir } = fileListSchema.parse(request.query);
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd) return response.status(409).json({ error: "That session is not open on this host" });
    response.json({ entries: await listProjectDirectory(cwd, dir) });
  });
  // Session-independent: the picker browses the host filesystem before any
  // session exists. The bearer token is the guard, as everywhere else.
  app.get("/api/host/dirs", async (request, response) => {
    const { path } = hostDirsSchema.parse(request.query);
    try {
      response.json(await listHostDirectories(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw Object.assign(new Error("No such directory on the host"), { status: 404 });
      if (code === "EACCES" || code === "EPERM")
        throw Object.assign(new Error("The host cannot read that directory"), { status: 403 });
      throw error;
    }
  });

  app.post("/api/resources/resolve", async (request, response) => {
    const { sessionId, reference } = resourceResolveSchema.parse(request.body);
    const context = await deps.runtime.resourceContext(sessionId);
    response.json(await deps.resources.resolve(context, reference));
  });
  app.get("/api/resources/:id/content", async (request, response) => {
    let closed = response.destroyed;
    response.once("close", () => {
      closed = true;
    });
    const { sessionId } = resourceContentSchema.parse(request.query);
    // Handles are bound to the session they were resolved in AND to that
    // session still being the visible one — a handle from session A must not
    // keep serving content after the user switches to session B.
    if (deps.runtime.activeSessionId !== sessionId) {
      throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
    }
    const resource = deps.resources.get(String(request.params.id), sessionId);
    response.set({
      "Content-Type": resource.descriptor.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(resource.descriptor.name)}`,
    });
    if (resource.embedded) {
      const context = await deps.runtime.resourceContext(sessionId);
      if (closed || response.destroyed) return;
      const data = await deps.resources.embeddedData(resource, context);
      if (closed || response.destroyed) return;
      const range = resourceByteRange(request, data.length);
      response.set("Accept-Ranges", "bytes");
      if (range) {
        response.status(206).set({
          "Content-Range": `bytes ${range.start}-${range.end}/${data.length}`,
          "Content-Length": String(range.end - range.start + 1),
        });
        response.send(data.subarray(range.start, range.end + 1));
      } else {
        response.set("Content-Length", String(data.length));
        response.send(data);
      }
    } else if (resource.path) {
      const { handle, size } = await deps.resources.openForServing(resource);
      if (closed || response.destroyed) {
        await handle.close();
        return;
      }
      let range: { start: number; end: number } | null;
      try {
        range = resourceByteRange(request, size);
      } catch (error) {
        await handle.close();
        throw error;
      }
      response.set("Accept-Ranges", "bytes");
      if (range) {
        response.status(206).set({
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(range.end - range.start + 1),
        });
      } else {
        response.set("Content-Length", String(size));
      }
      const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
      response.on("close", () => stream.destroy());
      stream.on("error", () => {
        if (!response.headersSent) response.status(500);
        response.end();
      });
      stream.pipe(response);
    } else {
      response.status(404).json({ error: "The resource preview is no longer available" });
    }
  });

  app.get("/api/preferences", async (_request, response) => response.json(await deps.preferences.read()));
  app.patch("/api/preferences", async (request, response) => {
    response.json(await deps.preferences.patch(request.body));
  });
  app.get("/api/snapshot", async (_request, response) => response.json(await deps.runtime.snapshot()));

  const distDir = resolve(deps.distDir ?? "dist");
  if (existsSync(distDir)) {
    // Content-hashed bundles under /assets are safe to cache forever. Every
    // other dist file is unhashed — theme-init.js, index.html — so it must
    // revalidate, or a rebuild is served stale for up to a year.
    app.use(
      "/assets",
      express.static(join(distDir, "assets"), { immutable: true, maxAge: "1y", fallthrough: true }),
    );
    app.use(express.static(distDir, { index: false, fallthrough: true, maxAge: 0 }));
    app.get("*path", (_request, response) => {
      response.set("Cache-Control", "no-cache");
      response.sendFile(resolve(distDir, "index.html"));
    });
  }

  app.use(apiError);
  const server = createServer(app);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const sockets = new Set<WebSocket>();
  /** Sockets still waiting for their snapshot; live events queue here so the
   * first frame a client processes is always the authoritative snapshot,
   * with the queued events flushed after it in arrival order. */
  const joining = new Map<WebSocket, { messages: string[]; bytes: number }>();
  const closeLaggingSocket = (socket: WebSocket, reason: string) => {
    joining.delete(socket);
    if (socket.readyState === WebSocket.OPEN) socket.close(1013, reason);
  };
  const sendBounded = (socket: WebSocket, message: string): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(message) > MAX_SOCKET_BUFFERED_BYTES) {
      closeLaggingSocket(socket, "Client fell behind");
      return false;
    }
    socket.send(message);
    return true;
  };
  deps.runtime.on("event", (event) => {
    const message = JSON.stringify(event);
    const messageBytes = Buffer.byteLength(message);
    for (const socket of sockets) {
      const queue = joining.get(socket);
      if (queue) {
        if (queue.bytes + messageBytes > MAX_JOINING_EVENT_BYTES) {
          closeLaggingSocket(socket, "Snapshot backlog exceeded");
        } else {
          queue.messages.push(message);
          queue.bytes += messageBytes;
        }
      } else {
        sendBounded(socket, message);
      }
    }
  });

  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (
      url.pathname !== "/events" ||
      url.searchParams.get("token") !== deps.token ||
      !originAllowed(request.headers.origin, request.headers.host)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
  });

  websocket.on("connection", (socket) => {
    sockets.add(socket);
    joining.set(socket, { messages: [], bytes: 0 });
    socket.on("close", () => {
      sockets.delete(socket);
      joining.delete(socket);
    });
    void deps.runtime.snapshot().then(
      (snapshot) => {
        const queued = joining.get(socket);
        joining.delete(socket);
        if (!queued || socket.readyState !== WebSocket.OPEN) return;
        if (!sendBounded(socket, JSON.stringify({ type: "snapshot", data: snapshot }))) return;
        for (const message of queued.messages) {
          if (!sendBounded(socket, message)) break;
        }
      },
      () => {
        joining.delete(socket);
        socket.close(1011, "Unable to load session state");
      },
    );
  });

  return {
    app,
    server,
    close: async () => {
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      await deps.runtime.close();
      await deps.attachments.close();
      if (server.listening) {
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        );
      }
    },
  };
}
