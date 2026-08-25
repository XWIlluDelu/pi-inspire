import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError, z } from "zod";
import {
  type BootstrapResponse,
  type GitDiffSide,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENTS,
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_PENDING_MESSAGES,
  MAX_PROJECT_FILES,
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type NewSessionDefaults,
  type PiUpdateCheckResponse,
  THINKING_LEVELS,
} from "../shared/contracts.js";
import {
  MAX_RESOURCE_LIST_PAGE_SIZE,
  MAX_RESOURCE_PROBE_REFERENCES,
  RESOURCE_LIST_INITIAL_SIZE,
} from "../shared/resource-references.js";
import { emptyToolPresentationConfiguration } from "../shared/tool-presentation-config.js";
import type { AttachmentStore } from "./attachments.js";
import type { GitInspectionLike } from "./git-inspection.js";
import { listHostDirectories, listHostRoots } from "./host-dirs.js";
import type { MaintenanceRestartOutcome } from "./maintenance-restart.js";
import type { PiUpdateCheckerLike } from "./pi-update-checker.js";
import type { PreferencesStore } from "./preferences.js";
import {
  invalidateProjectIndex,
  listProjectDirectory,
  searchProjectFiles,
} from "./project-files.js";
import type { ResourceStore } from "./resources.js";
import type { RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike } from "./session-catalog.js";
import type {
  ToolPresentationConfigLike,
  ToolPresentationConfigurationState,
} from "./tool-presentation-config.js";
import type { UpdateCheckerLike } from "./update-checker.js";

const pairSchema = z.object({ token: z.string().min(1).max(256) }).strict();
const openSchema = z.object({ id: z.string().min(1).max(128) });
const deleteSessionParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
});
const clearHiddenSchema = z
  .object({
    sessionIds: z.array(z.string().min(1).max(128)).min(1).max(10_000),
  })
  .strict();
const newSchema = z
  .object({
    cwd: z.string().min(1).max(4_096),
    name: z.string().max(160).optional(),
    model: z
      .object({
        provider: z.string().min(1).max(120),
        id: z.string().min(1).max(240),
      })
      .strict()
      .optional(),
    thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  })
  .strict();
const sessionIdField = z.string().min(1).max(200);
const promptSchema = z
  .object({
    sessionId: sessionIdField,
    message: z.string().max(500_000),
    attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
    historyArtifacts: z
      .object({
        viewId: z.string().min(1).max(240),
        incarnation: z.string().min(1).max(240).nullable(),
        effectiveLeafId: z.string().min(1).max(240).nullable(),
        imageReferences: z
          .array(
            z
              .string()
              .max(80)
              .regex(/^pi-embedded:\/\/\d+\/\d+$/),
          )
          .max(MAX_ATTACHMENTS),
        fileReferences: z
          .array(
            z
              .string()
              .max(80)
              .regex(/^pi-file:\/\/\d+\/\d+$/),
          )
          .max(MAX_ATTACHMENTS + MAX_PROJECT_FILES),
      })
      .strict()
      .refine(
        ({ imageReferences, fileReferences }) =>
          imageReferences.length + fileReferences.length > 0,
      )
      .optional(),
    projectFiles: z
      .array(z.string().max(4_096))
      .max(MAX_PROJECT_FILES)
      .optional(),
    behavior: z.enum(["steer", "followUp"]).optional(),
  })
  .strict();
const abortSchema = z.object({ sessionId: sessionIdField });
const pendingManagementSchema = z.discriminatedUnion("action", [
  z
    .object({
      sessionId: sessionIdField,
      action: z.literal("pause"),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdField,
      action: z.literal("resume"),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdField,
      action: z.literal("delete"),
      expectedRevision: z.number().int().nonnegative(),
      messageId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdField,
      action: z.literal("clear"),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdField,
      action: z.literal("convert"),
      expectedRevision: z.number().int().nonnegative(),
      messageId: z.string().min(1).max(200),
      target: z.enum(["steer", "followUp"]),
    })
    .strict(),
]);
const pendingMessageTextsSchema = z
  .object({
    sessionId: sessionIdField,
    messageIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(MAX_PENDING_MESSAGES),
  })
  .strict()
  .refine(
    ({ messageIds }) => new Set(messageIds).size === messageIds.length,
    "messageIds must be unique",
  );
const renameSchema = z.object({
  sessionId: sessionIdField,
  name: z.string().max(160),
});
const modelSchema = z.object({
  sessionId: sessionIdField,
  provider: z.string().min(1).max(120),
  modelId: z.string().min(1).max(240),
});
const thinkingSchema = z.object({
  sessionId: sessionIdField,
  level: z.enum(THINKING_LEVELS),
});
const extensionSchema = z
  .object({
    sessionId: sessionIdField,
    id: z.string().min(1).max(200),
  })
  .passthrough();
const sessionQuerySchema = z.object({
  q: z.string().max(200).default(""),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SESSION_LIST_PAGE_SIZE)
    .default(40),
});
const fileQuerySchema = z.object({
  sessionId: sessionIdField,
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const newSessionDefaultsQuerySchema = z.object({
  cwd: z.string().min(1).max(4_096),
});
const newSessionFileQuerySchema = z.object({
  cwd: z.string().min(1).max(4_096),
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const fileListSchema = z.object({
  sessionId: sessionIdField,
  dir: z
    .string()
    .max(4_096)
    .default("")
    .refine(
      (value) => !value.split("/").includes(".."),
      "dir must stay inside the project",
    ),
  refresh: z.literal("1").optional(),
});
const hostDirsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4_096)
    .refine(isAbsolute, "path must be absolute")
    .optional(),
});
// Hydration unions can also contain selected/live identities, so the browser
// chunks the deduplicated union to this explicit per-request contract.
const sessionIdsSchema = z.object({
  ids: z.array(z.string().min(1).max(128)).max(MAX_SESSION_ID_HYDRATION_IDS),
});
const sessionCwdsSchema = z.object({
  cwds: z
    .array(z.string().min(1).max(4_096))
    .max(MAX_SESSION_CWD_HYDRATION_CWDS),
});
const attachmentIdSchema = z.string().uuid();
const resourceListSchema = z
  .object({
    sessionId: sessionIdField,
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESOURCE_LIST_PAGE_SIZE)
      .default(RESOURCE_LIST_INITIAL_SIZE),
  })
  .strict();
const resourceResolveSchema = z.object({
  sessionId: sessionIdField,
  reference: z.string().min(1).max(8_192),
});
const resourceProbeSchema = z.object({
  sessionId: sessionIdField,
  references: z
    .array(z.string().min(1).max(8_192))
    .max(MAX_RESOURCE_PROBE_REFERENCES),
});
const resourceContentSchema = z.object({ sessionId: sessionIdField });
const transcriptPageSchema = z.object({
  sessionId: sessionIdField,
  cursor: z.string().min(1).max(2_048),
});
const transcriptOlderPageSchema = transcriptPageSchema.extend({
  deferActivity: z.literal("1").optional(),
});
const transcriptUserTurnsSchema = z
  .object({
    sessionId: sessionIdField,
    start: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
const transcriptUserTurnSchema = z
  .object({
    sessionId: sessionIdField,
    id: z.string().min(1).max(512),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();
const composerHistorySchema = z
  .object({
    sessionId: sessionIdField,
    start: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_COMPOSER_HISTORY_ENTRIES)
      .optional(),
  })
  .strict();
const branchTreeSchema = z.object({ sessionId: sessionIdField });
const branchNavigateSchema = z
  .object({
    sessionId: sessionIdField,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    targetId: z.string().min(1).max(200),
    mode: z.enum(["switch", "edit"]),
  })
  .strict();
const branchForkSchema = z
  .object({
    sessionId: sessionIdField,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    targetId: z.string().min(1).max(200),
  })
  .strict();
const gitStatusSchema = z.object({ sessionId: sessionIdField });
const gitDiffSchema = z.object({
  sessionId: sessionIdField,
  pathId: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^[A-Za-z0-9_-]+$/),
  side: z.enum(["staged", "unstaged"] satisfies GitDiffSide[]),
});

export const MAX_JOINING_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 20_000;
const ACCESS_COOKIE = "inspire_access";
const ACCESS_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1_000;

/** Cookies are scoped by host but not by port. Derive a name per Host origin
 * so pairing another local port cannot overwrite this instance's token. */
export function accessCookieName(host: string | undefined): string {
  const suffix = createHash("sha256")
    .update(host?.trim().toLowerCase() || "missing-host")
    .digest("base64url")
    .slice(0, 12);
  return `${ACCESS_COOKIE}_${suffix}`;
}

interface MaintenanceRestartLike {
  reserve(): Promise<MaintenanceRestartOutcome>;
}

interface AppDependencies {
  token: string;
  runtime: RuntimeLike;
  catalog: SessionCatalogLike;
  attachments: AttachmentStore;
  preferences: PreferencesStore;
  toolPresentations?: ToolPresentationConfigLike;
  resources: ResourceStore;
  git: GitInspectionLike;
  mock: boolean;
  version: string;
  piVersion: string;
  /** Authenticated timer coordination; it detects installed updates and asks
   * the runtime for its short idle fence, never restarts systemd itself. */
  maintenanceRestart?: MaintenanceRestartLike;
  /** Browser-safe configured model metadata, available without a live worker. */
  availableModels?: () => Promise<BootstrapResponse["availableModels"]>;
  /** Cached public-release observation; failures never block local work. */
  updateChecker?: UpdateCheckerLike;
  /** Read-only Pi and configured-package update observation. */
  piUpdateChecker?: PiUpdateCheckerLike;
  /** Read-only Pi startup resolution for a canonical prospective workspace. */
  newSessionDefaults?: (cwd: string) => Promise<NewSessionDefaults>;
  distDir?: string;
  /** Internal cadence override used by the transport liveness test. */
  websocketHeartbeatIntervalMs?: number;
}

async function prospectiveWorkspaceRoot(cwd: string): Promise<string> {
  let root: string;
  let details;
  try {
    root = await realpath(resolve(cwd));
    details = await stat(root);
  } catch {
    throw Object.assign(new Error("Project path does not exist"), {
      status: 400,
    });
  }
  if (!details.isDirectory()) {
    throw Object.assign(new Error("Project path is not a directory"), {
      status: 400,
    });
  }
  return root;
}

function bearerToken(request: Request): string | undefined {
  const value = request.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function cookieToken(
  header: string | undefined,
  host: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const expectedName = accessCookieName(host);
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== expectedName)
      continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function tokenMatches(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function setAccessCookie(
  request: Request,
  response: Response,
  token: string,
): void {
  response.cookie(accessCookieName(request.get("host")), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: request.secure,
    path: "/",
    maxAge: ACCESS_COOKIE_MAX_AGE_MS,
  });
}

function originAllowed(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host === host
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/** An HTTPS edge must overwrite this header while forwarding over a local hop.
 * Direct loopback requests never carry it, so their launch URL remains local. */
function trustedForwardedHttps(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  return (
    isLoopbackAddress(request.socket.remoteAddress) &&
    typeof forwarded === "string" &&
    forwarded.trim().toLowerCase() === "https"
  );
}

/** This endpoint deliberately supports one byte range. Express owns RFC
 * parsing (including suffix and open-ended forms); malformed, unsatisfiable,
 * non-byte, and multi-range requests fail rather than unexpectedly receiving
 * the whole potentially large resource. */
function resourceByteRange(
  request: Request,
  size: number,
): { start: number; end: number } | null {
  if (!request.get("range")) return null;
  const ranges = request.range(size);
  if (
    !Array.isArray(ranges) ||
    ranges.type !== "bytes" ||
    ranges.length !== 1
  ) {
    throw Object.assign(
      new Error("The requested byte range cannot be served"),
      { status: 416 },
    );
  }
  return ranges[0]!;
}

async function withRequestSignal<T>(
  request: Request,
  response: Response,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfUnfinished = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortIfUnfinished);
  try {
    return await operation(controller.signal);
  } finally {
    request.off("aborted", abort);
    response.off("close", abortIfUnfinished);
  }
}

function apiError(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const status =
    error instanceof ZodError
      ? 400
      : error instanceof multer.MulterError
        ? error.code === "LIMIT_FILE_SIZE"
          ? 413
          : 400
        : Number((error as { status?: unknown })?.status) || 500;
  const message =
    error instanceof Error ? error.message : "Unexpected server error";
  if (status >= 500)
    console.error(`[${request.method} ${request.path}]`, error);
  // A refusal may carry the candidates the host declined to choose between.
  const matches = (error as { matches?: unknown })?.matches;
  response
    .status(status)
    .json(
      Array.isArray(matches) ? { error: message, matches } : { error: message },
    );
}

export function createInspireServer(deps: AppDependencies): {
  app: express.Express;
  server: Server;
  close: () => Promise<void>;
} {
  const app = express();
  // The host itself remains loopback-only. A local reverse proxy may report
  // the original HTTPS protocol, but arbitrary network hops never gain trust.
  app.set("trust proxy", "loopback");
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
    if (request.path.startsWith("/api/"))
      response.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));

  // Pair one browser profile to this loopback host. The credential becomes an
  // origin-scoped HttpOnly cookie; it never needs durable JavaScript storage.
  app.post("/api/auth/pair", (request, response) => {
    if (!originAllowed(request.get("origin"), request.get("host"))) {
      return response.status(403).json({ error: "Origin is not allowed" });
    }
    const { token } = pairSchema.parse(request.body);
    if (!tokenMatches(token, deps.token))
      return response.status(401).json({ error: "Access token is not valid" });
    setAccessCookie(request, response, deps.token);
    response.status(204).end();
  });

  app.use("/api", (request, response, next) => {
    if (!originAllowed(request.get("origin"), request.get("host"))) {
      return response.status(403).json({ error: "Origin is not allowed" });
    }
    const bearer = bearerToken(request);
    const cookie = cookieToken(request.get("cookie"), request.get("host"));
    if (
      !tokenMatches(bearer, deps.token) &&
      !tokenMatches(cookie, deps.token)
    ) {
      return response.status(401).json({ error: "Authentication required" });
    }
    // Existing token URLs and non-cookie clients transparently establish the
    // browser pairing on their first authenticated API request.
    if (tokenMatches(bearer, deps.token) && !tokenMatches(cookie, deps.token)) {
      setAccessCookie(request, response, deps.token);
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ appName: "inspire", mock: deps.mock });
  });

  app.get("/api/update", async (request, response) => {
    response.json(
      deps.updateChecker
        ? await deps.updateChecker.check(request.query.refresh === "1")
        : { kind: "unavailable" },
    );
  });

  app.get("/api/pi-update", async (request, response) => {
    const unavailable: PiUpdateCheckResponse = {
      currentVersion: deps.piVersion,
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    };
    response.json(
      deps.piUpdateChecker
        ? await deps.piUpdateChecker.check(request.query.refresh === "1")
        : unavailable,
    );
  });

  /** A successful response is a short exclusive lease. The local user timer
   * consumes it immediately by asking systemd to restart the verified unit. */
  app.post("/api/maintenance/restart", async (_request, response) => {
    response.json(
      deps.maintenanceRestart
        ? await deps.maintenanceRestart.reserve()
        : { kind: "skipped", reason: "runtime-unsupported" },
    );
  });

  app.get("/api/bootstrap", async (_request, response) => {
    const [preferenceState, toolPresentationState, availableModels, snapshot] =
      await Promise.all([
        deps.preferences.inspect(),
        deps.toolPresentations
          ? deps.toolPresentations.inspect()
          : Promise.resolve<ToolPresentationConfigurationState>({
              configuration: emptyToolPresentationConfiguration(),
            }),
        deps.availableModels ? deps.availableModels() : Promise.resolve([]),
        deps.runtime.snapshot(),
      ]);
    const body: BootstrapResponse = {
      appName: "inspire",
      version: deps.version,
      piVersion: deps.piVersion,
      mock: deps.mock,
      preferences: preferenceState.preferences,
      ...(preferenceState.warning
        ? { preferencesWarning: preferenceState.warning }
        : {}),
      toolPresentations: toolPresentationState.configuration,
      ...(toolPresentationState.warning
        ? { toolPresentationsWarning: toolPresentationState.warning }
        : {}),
      availableModels,
      snapshot,
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
  app.post("/api/sessions/by-cwd", async (request, response) => {
    const { cwds } = sessionCwdsSchema.parse(request.body);
    response.json({ sessions: await deps.catalog.listByCwds(cwds) });
  });
  app.post("/api/sessions/open", async (request, response) => {
    const { id } = openSchema.parse(request.body);
    response.json(await deps.runtime.openSession(id));
  });
  app.post("/api/sessions/deselect", async (_request, response) => {
    response.json(await deps.runtime.deselectSession());
  });
  app.post("/api/sessions/new", async (request, response) => {
    const { cwd, name, model, thinkingLevel } = newSchema.parse(request.body);
    response.json(
      await deps.runtime.newSession(cwd, { name, model, thinkingLevel }),
    );
  });
  // These endpoints are read-only previews for the start surface. They neither
  // create a session nor authorize later file reads; the resulting session
  // worker and prompt boundary re-resolve the workspace and file references.
  app.get("/api/new-session/defaults", async (request, response) => {
    const { cwd } = newSessionDefaultsQuerySchema.parse(request.query);
    const root = await prospectiveWorkspaceRoot(cwd);
    if (!deps.newSessionDefaults) {
      return response
        .status(503)
        .json({ error: "New-session model resolution is unavailable" });
    }
    response.json({ ...(await deps.newSessionDefaults(root)), cwd: root });
  });
  app.get("/api/new-session/files", async (request, response) => {
    const { cwd, q, limit } = newSessionFileQuerySchema.parse(request.query);
    const root = await prospectiveWorkspaceRoot(cwd);
    response.json({
      cwd: root,
      files: await searchProjectFiles(root, q, limit),
    });
  });
  app.post("/api/sessions/rename", async (request, response) => {
    const { sessionId, name } = renameSchema.parse(request.body);
    await deps.runtime.rename(sessionId, name);
    response.json({ ok: true });
  });
  app.delete("/api/sessions/:sessionId", async (request, response) => {
    const { sessionId } = deleteSessionParamsSchema.parse(request.params);
    const result = await deps.runtime.deleteSession(sessionId);
    deps.resources.forgetSession(sessionId);
    try {
      const preferences = await deps.preferences.removeSession(sessionId);
      response.json({ ...result, preferences });
    } catch (error) {
      // The destructive result is already known. Never turn a metadata-write
      // failure into a retryable DELETE whose second execution is ambiguous.
      console.error(
        `[session ${sessionId}] navigation metadata cleanup failed`,
        error,
      );
      response.json({ ...result, preferenceCleanupFailed: true });
    }
  });
  app.post("/api/sessions/clear-hidden", async (request, response) => {
    const { sessionIds } = clearHiddenSchema.parse(request.body);
    const current = await deps.preferences.inspect();
    const reviewedHiddenSessionIds = current.preferences.hiddenSessionIds;
    const reviewedHiddenProjectCwds = current.preferences.hiddenProjectCwds;
    if (
      reviewedHiddenSessionIds.length === 0 &&
      reviewedHiddenProjectCwds.length === 0
    ) {
      return response.status(409).json({
        error: "Hidden must remain non-empty before it can be cleared",
      });
    }
    const result = await deps.runtime.clearHiddenSessions(
      sessionIds,
      reviewedHiddenSessionIds,
      reviewedHiddenProjectCwds,
    );
    for (const session of result.deleted)
      deps.resources.forgetSession(session.sessionId);
    if (result.deleted.length === 0) return response.json(result);
    try {
      const preferences = await deps.preferences.removeClearedHidden(
        result.deleted.map((session) => session.sessionId),
        reviewedHiddenSessionIds,
        reviewedHiddenProjectCwds,
        !result.failure,
      );
      response.json({ ...result, preferences });
    } catch (error) {
      // Earlier files are already in Trash (or permanently removed). Return
      // that committed subset and never turn it into a retryable batch.
      console.error(
        `[Hidden] navigation metadata cleanup failed after deleting ${result.deleted.length} sessions`,
        error,
      );
      response.json({ ...result, preferenceCleanupFailed: true });
    }
  });

  const upload = multer({
    storage: deps.attachments.multerStorage(),
    limits: {
      fileSize: MAX_ATTACHMENT_FILE_BYTES,
      files: MAX_ATTACHMENTS,
      fields: MAX_ATTACHMENTS,
    },
  });
  app.post(
    "/api/attachments",
    upload.array("files", MAX_ATTACHMENTS),
    async (request, response) => {
      const files = Array.isArray(request.files) ? request.files : [];
      if (files.length === 0)
        return response.status(400).json({ error: "No files provided" });
      response.json({ attachments: await deps.attachments.addMany(files) });
    },
  );
  app.delete("/api/attachments/:id", async (request, response) => {
    await deps.attachments.remove(attachmentIdSchema.parse(request.params.id));
    response.json({ ok: true });
  });

  app.post("/api/prompt", async (request, response) => {
    const historyEntry = await deps.runtime.prompt(
      promptSchema.parse(request.body),
    );
    response.status(202).json({ accepted: true, historyEntry });
  });
  app.post("/api/control/abort", async (request, response) => {
    const { sessionId } = abortSchema.parse(request.body);
    await deps.runtime.abort(sessionId);
    response.json({ ok: true });
  });
  app.post("/api/pending", async (request, response) => {
    const { sessionId, ...management } = pendingManagementSchema.parse(
      request.body,
    );
    response.json({
      pendingQueues: await deps.runtime.managePending(sessionId, management),
    });
  });
  app.post("/api/pending/text", async (request, response) => {
    const { sessionId, messageIds } = pendingMessageTextsSchema.parse(
      request.body,
    );
    response.setHeader("Cache-Control", "no-store");
    response.json({
      messages: await deps.runtime.pendingMessageTexts(sessionId, messageIds),
    });
  });
  app.post("/api/control/model", async (request, response) => {
    const value = modelSchema.parse(request.body);
    response.json(
      await deps.runtime.setModel(
        value.sessionId,
        value.provider,
        value.modelId,
      ),
    );
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
    if (!cwd)
      return response
        .status(409)
        .json({ error: "That session is not open on this host" });
    response.json({ files: await searchProjectFiles(cwd, q, limit) });
  });
  app.get("/api/files/list", async (request, response) => {
    const { sessionId, dir, refresh } = fileListSchema.parse(request.query);
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd)
      return response
        .status(409)
        .json({ error: "That session is not open on this host" });
    if (refresh) invalidateProjectIndex(cwd);
    response.json({ entries: await listProjectDirectory(cwd, dir) });
  });
  app.get("/api/git/status", async (request, response) => {
    const { sessionId } = gitStatusSchema.parse(request.query);
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd)
      return response
        .status(409)
        .json({ error: "That session is not open on this host" });
    response.json(
      await withRequestSignal(request, response, (signal) =>
        deps.git.status(cwd, signal),
      ),
    );
  });
  app.post("/api/git/diff", async (request, response) => {
    const { sessionId, pathId, side } = gitDiffSchema.parse(request.body);
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd)
      return response
        .status(409)
        .json({ error: "That session is not open on this host" });
    response.json(
      await withRequestSignal(request, response, (signal) =>
        deps.git.diff(cwd, pathId, side, signal),
      ),
    );
  });

  // Session-independent: the picker browses the host filesystem before any
  // session exists. The bearer token is the guard, as everywhere else.
  app.get("/api/host/roots", async (_request, response) => {
    response.json(await listHostRoots());
  });

  app.get("/api/host/dirs", async (request, response) => {
    const { path } = hostDirsSchema.parse(request.query);
    try {
      response.json(await listHostDirectories(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw Object.assign(new Error("No such directory on the host"), {
          status: 404,
        });
      if (code === "EACCES" || code === "EPERM")
        throw Object.assign(new Error("The host cannot read that directory"), {
          status: 403,
        });
      throw error;
    }
  });

  app.post("/api/resources/list", async (request, response) => {
    const { sessionId, cursor, limit } = resourceListSchema.parse(request.body);
    const context = await deps.runtime.resourceContext(sessionId);
    const page = await deps.resources.list(context, { cursor, limit });
    response.json({
      sessionId,
      viewId: context.viewId,
      revision: context.revision,
      ...page,
    });
  });
  app.post("/api/resources/probe", async (request, response) => {
    const { sessionId, references } = resourceProbeSchema.parse(request.body);
    const context = await deps.runtime.resourceContext(sessionId);
    response.json({
      sessionId,
      viewId: context.viewId,
      revision: context.revision,
      results: await deps.resources.probe(context, references),
    });
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
    // Handles are bound to the opaque branch view that authorized them. The
    // current authority is rechecked before any headers or bytes are sent.
    const context = await deps.runtime.resourceContext(sessionId);
    const resource = deps.resources.get(
      String(request.params.id),
      sessionId,
      context.viewId,
    );
    await deps.resources.revalidate(resource, context);
    if (closed || response.destroyed) return;
    response.set({
      "Content-Type": resource.descriptor.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(resource.descriptor.name)}`,
    });
    if (resource.embedded) {
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
      const stream = handle.createReadStream(
        range ? { start: range.start, end: range.end } : {},
      );
      response.on("close", () => stream.destroy());
      stream.on("error", () => {
        if (!response.headersSent) response.status(500);
        response.end();
      });
      stream.pipe(response);
    } else {
      response
        .status(404)
        .json({ error: "The resource preview is no longer available" });
    }
  });

  app.get("/api/preferences", async (_request, response) =>
    response.json(await deps.preferences.read()),
  );
  app.patch("/api/preferences", async (request, response) => {
    response.json(await deps.preferences.patch(request.body));
  });
  app.get("/api/snapshot", async (_request, response) =>
    response.json(await deps.runtime.snapshot()),
  );
  app.get("/api/transcript/older", async (request, response) => {
    const { sessionId, cursor, deferActivity } =
      transcriptOlderPageSchema.parse(request.query);
    response.json(
      await deps.runtime.transcriptPage(
        sessionId,
        cursor,
        deferActivity === "1",
      ),
    );
  });
  app.get("/api/transcript/activity", async (request, response) => {
    const { sessionId, cursor } = transcriptPageSchema.parse(request.query);
    response.json(await deps.runtime.transcriptActivityPage(sessionId, cursor));
  });
  app.get("/api/transcript/user-turns", async (request, response) => {
    const { sessionId, start } = transcriptUserTurnsSchema.parse(request.query);
    response.json(await deps.runtime.transcriptUserTurns(sessionId, start));
  });
  app.get("/api/transcript/user-turn", async (request, response) => {
    const { sessionId, id, cursor } = transcriptUserTurnSchema.parse(
      request.query,
    );
    response.json(await deps.runtime.transcriptUserTurn(sessionId, id, cursor));
  });
  app.get("/api/composer/history", async (request, response) => {
    const { sessionId, start } = composerHistorySchema.parse(request.query);
    response.json(await deps.runtime.composerHistory(sessionId, start));
  });
  app.get("/api/branches/tree", async (request, response) => {
    const { sessionId } = branchTreeSchema.parse(request.query);
    response.json(await deps.runtime.branchTree(sessionId));
  });
  app.post("/api/branches/navigate", async (request, response) => {
    response.json(
      await deps.runtime.navigateBranch(
        branchNavigateSchema.parse(request.body),
      ),
    );
  });
  app.post("/api/branches/fork", async (request, response) => {
    response.json(
      await deps.runtime.forkBranch(branchForkSchema.parse(request.body)),
    );
  });

  // Unknown API paths are protocol errors, never client-side routes. Keep
  // them out of the SPA fallback so a typo cannot return index.html as 200.
  app.all(["/api", "/api/*path"], (_request, response) => {
    response.status(404).json({ error: "API route not found" });
  });

  const distDir = resolve(deps.distDir ?? "dist");
  if (existsSync(distDir)) {
    // A direct local launcher may pair before the application bundle runs,
    // then removes the bearer from browser history. An HTTPS request forwarded
    // through a trusted loopback proxy still strips this parameter, but must
    // use the ordinary Pair form rather than treating a public URL as a bearer.
    app.get("/", (request, response, next) => {
      const candidate =
        typeof request.query.token === "string"
          ? request.query.token
          : undefined;
      if (candidate === undefined) return next();
      if (
        !trustedForwardedHttps(request) &&
        tokenMatches(candidate, deps.token)
      ) {
        setAccessCookie(request, response, deps.token);
      }
      const clean = new URL(
        request.originalUrl,
        `http://${request.get("host") ?? "127.0.0.1"}`,
      );
      clean.searchParams.delete("token");
      response.redirect(
        303,
        `${clean.pathname}${clean.search}${clean.hash}` || "/",
      );
    });
    // Content-hashed bundles under /assets are safe to cache forever. Every
    // other dist file is unhashed — theme-init.js, index.html — so it must
    // revalidate, or a rebuild is served stale for up to a year.
    app.use(
      "/assets",
      express.static(join(distDir, "assets"), {
        immutable: true,
        maxAge: "1y",
        fallthrough: true,
      }),
    );
    app.use(
      express.static(distDir, { index: false, fallthrough: true, maxAge: 0 }),
    );
    app.get("*path", (_request, response) => {
      response.set("Cache-Control", "no-cache");
      response.sendFile(resolve(distDir, "index.html"));
    });
  }

  app.use(apiError);
  const server = createServer(app);
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });
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
    if (
      socket.bufferedAmount + Buffer.byteLength(message) >
      MAX_SOCKET_BUFFERED_BYTES
    ) {
      closeLaggingSocket(socket, "Client fell behind");
      return false;
    }
    socket.send(message);
    return true;
  };
  const responsiveSockets = new Map<WebSocket, boolean>();
  const heartbeatMessage = JSON.stringify({ type: "heartbeat" });
  const heartbeatInterval = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!responsiveSockets.get(socket)) {
        joining.delete(socket);
        socket.terminate();
        continue;
      }
      responsiveSockets.set(socket, false);
      try {
        socket.ping();
      } catch {
        joining.delete(socket);
        socket.terminate();
        continue;
      }
      // Never overtake the authoritative first snapshot. Once joined, this
      // application frame also gives browser clients an observable watchdog.
      if (!joining.has(socket)) sendBounded(socket, heartbeatMessage);
    }
  }, deps.websocketHeartbeatIntervalMs ?? WEBSOCKET_HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  deps.runtime.on("event", (event) => {
    const message = JSON.stringify(event);
    const messageBytes = Buffer.byteLength(message);
    if (messageBytes > MAX_RUNTIME_EVENT_BYTES) {
      // The next bootstrap snapshot is the recovery authority. Never enqueue
      // one exceptional extension/runtime object into every browser socket.
      for (const socket of sockets)
        closeLaggingSocket(socket, "Runtime event exceeded projection budget");
      return;
    }
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
      url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
    } catch {
      socket.destroy();
      return;
    }
    const queryToken = url.searchParams.get("token") ?? undefined;
    const pairedToken = cookieToken(
      request.headers.cookie,
      request.headers.host,
    );
    const queryTokenAllowed =
      !trustedForwardedHttps(request) || queryToken === undefined;
    if (
      url.pathname !== "/events" ||
      !queryTokenAllowed ||
      (!tokenMatches(queryToken, deps.token) &&
        !tokenMatches(pairedToken, deps.token)) ||
      !originAllowed(request.headers.origin, request.headers.host)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) =>
      websocket.emit("connection", client, request),
    );
  });

  websocket.on("connection", (socket) => {
    sockets.add(socket);
    joining.set(socket, { messages: [], bytes: 0 });
    responsiveSockets.set(socket, true);
    socket.on("pong", () => responsiveSockets.set(socket, true));
    socket.on("close", () => {
      sockets.delete(socket);
      joining.delete(socket);
      responsiveSockets.delete(socket);
    });
    void deps.runtime.snapshot().then(
      (snapshot) => {
        const queued = joining.get(socket);
        joining.delete(socket);
        if (!queued || socket.readyState !== WebSocket.OPEN) return;
        if (
          !sendBounded(
            socket,
            JSON.stringify({ type: "snapshot", data: snapshot }),
          )
        )
          return;
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
      clearInterval(heartbeatInterval);
      // Stop accepting HTTP/upgrades first, but do not await the drain before
      // runtime teardown: an active request may itself be waiting on runtime.
      const drained = server.listening
        ? new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
          })
        : Promise.resolve();
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      const runtimeResult = await deps.runtime.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      server.closeIdleConnections?.();
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      server.closeAllConnections?.();
      const drainedResult = await drained.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const resourceResult = await deps.resources.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const attachmentResult = await deps.attachments.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const failures = [
        runtimeResult,
        drainedResult,
        resourceResult,
        attachmentResult,
      ]
        .filter(
          (result): result is { status: "rejected"; reason: unknown } =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Inspire server shutdown failed");
    },
  };
}
