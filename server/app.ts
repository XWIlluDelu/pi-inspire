import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
import type { PreferencesStore } from "./preferences.js";
import { searchProjectFiles } from "./project-files.js";
import type { ResourceStore } from "./resources.js";
import type { RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike } from "./session-catalog.js";

const openSchema = z.object({ id: z.string().min(1).max(128) });
const newSchema = z.object({ cwd: z.string().min(1).max(4_096), name: z.string().max(160).optional() });
const promptSchema = z.object({
  message: z.string().max(500_000),
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
  projectFiles: z.array(z.string().max(4_096)).max(MAX_PROJECT_FILES).optional(),
  behavior: z.enum(["steer", "followUp"]).optional(),
});
const renameSchema = z.object({ name: z.string().max(160) });
const modelSchema = z.object({ provider: z.string().min(1).max(120), modelId: z.string().min(1).max(240) });
const thinkingSchema = z.object({ level: z.enum(THINKING_LEVELS) });
const extensionSchema = z.object({
  sessionId: z.string().min(1).max(200),
  id: z.string().min(1).max(200),
}).passthrough();
const sessionQuerySchema = z.object({
  q: z.string().max(200).default(""),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
const fileQuerySchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const sessionIdsSchema = z.object({ ids: z.array(z.string().min(1).max(128)).max(100) });
const pinSchema = z.object({ id: z.string().min(1).max(128), pinned: z.boolean() });
const resourceResolveSchema = z.object({
  sessionId: z.string().min(1).max(128),
  reference: z.string().min(1).max(8_192),
});
const resourceContentSchema = z.object({ sessionId: z.string().min(1).max(128) });

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
        "img-src 'self' data: blob: http: https:",
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
    const { name } = renameSchema.parse(request.body);
    await deps.runtime.rename(name);
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

  app.post("/api/prompt", async (request, response) => {
    await deps.runtime.prompt(promptSchema.parse(request.body));
    response.status(202).json({ accepted: true });
  });
  app.post("/api/control/abort", async (_request, response) => {
    await deps.runtime.abort();
    response.json({ ok: true });
  });
  app.post("/api/control/compact", async (request, response) => {
    const customInstructions = z.object({ customInstructions: z.string().max(10_000).optional() }).parse(request.body).customInstructions;
    response.json(await deps.runtime.compact(customInstructions));
  });
  app.post("/api/control/model", async (request, response) => {
    const value = modelSchema.parse(request.body);
    response.json(await deps.runtime.setModel(value.provider, value.modelId));
  });
  app.post("/api/control/thinking", async (request, response) => {
    const { level } = thinkingSchema.parse(request.body);
    await deps.runtime.setThinkingLevel(level);
    response.json({ ok: true });
  });
  app.post("/api/extension-ui", async (request, response) => {
    await deps.runtime.extensionUiResponse(extensionSchema.parse(request.body));
    response.json({ ok: true });
  });

  app.get("/api/files", async (request, response) => {
    if (!deps.runtime.activeCwd) return response.status(409).json({ error: "Open or create a session first" });
    const { q, limit } = fileQuerySchema.parse(request.query);
    response.json({ files: await searchProjectFiles(deps.runtime.activeCwd, q, limit) });
  });

  app.post("/api/resources/resolve", async (request, response) => {
    const { sessionId, reference } = resourceResolveSchema.parse(request.body);
    const context = await deps.runtime.resourceContext(sessionId);
    response.json(await deps.resources.resolve(context, reference));
  });
  app.get("/api/resources/:id/content", async (request, response) => {
    const { sessionId } = resourceContentSchema.parse(request.query);
    const resource = deps.resources.get(String(request.params.id), sessionId);
    response.set({
      "Content-Type": resource.descriptor.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(resource.descriptor.name)}`,
    });
    if (resource.embedded) {
      const context = await deps.runtime.resourceContext(sessionId);
      response.send(deps.resources.embeddedData(resource, context));
    } else if (resource.path) {
      response.sendFile(resource.path);
    } else {
      response.status(404).json({ error: "The resource preview is no longer available" });
    }
  });

  app.get("/api/preferences", async (_request, response) => response.json(await deps.preferences.read()));
  app.put("/api/preferences", async (request, response) => {
    response.json(await deps.preferences.write(request.body));
  });
  app.get("/api/snapshot", async (_request, response) => response.json(await deps.runtime.snapshot()));

  const distDir = resolve(deps.distDir ?? "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, fallthrough: true, immutable: true, maxAge: "1y" }));
    app.get("*path", (_request, response) => response.sendFile(resolve(distDir, "index.html")));
  }

  app.use(apiError);
  const server = createServer(app);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const sockets = new Set<WebSocket>();
  deps.runtime.on("event", (event) => {
    const message = JSON.stringify(event);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
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
    socket.on("close", () => sockets.delete(socket));
    void deps.runtime.snapshot().then(
      (snapshot) => socket.send(JSON.stringify({ type: "snapshot", data: snapshot })),
      () => socket.close(1011, "Unable to load session state"),
    );
  });

  return {
    app,
    server,
    close: async () => {
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      await deps.runtime.close();
      await deps.attachments.close();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}
