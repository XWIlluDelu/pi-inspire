import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import {
  BROWSER_BUILD_HEADER,
  BROWSER_UPGRADE_REQUIRED,
} from "../shared/browser-build.mjs";
import {
  type BootstrapResponse,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENTS,
  type SessionDeletionResponse,
  type UploadedAttachment,
} from "../shared/contracts.js";
import type { HerdrEnhancementStatus } from "../shared/herdr.js";
import { historyAddress } from "../shared/history-query.js";
import { hostEndpoints, sessionIdField } from "../shared/host-endpoints.js";
import {
  type HostOperationCommand,
  type HostOperationIdentity,
  type HostOperationReceipt,
  type HostOperationResults,
  hostReceipt,
  INPUT_OPERATION_PATHS,
  pendingOperationRequestSchema,
  pendingOperationSchema,
  promptFingerprintInput,
  promptObservationSchema,
  promptSchema,
} from "../shared/host-operations.js";
import { restartObservation } from "../shared/host-restart.js";
import { emptyToolPresentationConfiguration } from "../shared/tool-presentation-config.js";
import type { AttachmentStore } from "./attachments.js";
import {
  BrowserAuth,
  canonicalOrigin,
  challengeSchema,
  downloadOriginAllowed,
  exchangeSchema,
  registrationSchema,
  socketTicketSchema,
  secretMatches as tokenMatches,
} from "./browser-auth.js";
import { currentWebBuild } from "./current-web-build.mjs";
import { showInFileManager } from "./file-manager.js";
import { GeneratedExportStore } from "./generated-exports.js";
import type { GitInspectionService } from "./git-inspection.js";
import { listHostDirectories, listHostRoots } from "./host-dirs.js";
import { serveHtmlPreview } from "./html-preview.js";
import { InstanceHttpControl } from "./instance-control.mjs";
import { type InstanceState, instanceUrl } from "./instance-state.mjs";
import { jsonRoute } from "./json-route.js";
import type { MaintenanceRestartController } from "./maintenance-restart.js";
import type { McpConfigService } from "./mcp-config.js";
import { registerMcpConfigRoutes } from "./mcp-config-routes.js";
import type { NativeModelCatalog } from "./model-metadata.js";
import type { ModelSettingsService } from "./model-settings.js";
import { commonModelOptions } from "./model-settings.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { OperationReceipts } from "./operation-receipts.js";
import { resolveProjectDirectory } from "./paths.js";
import { PendingOperationReceipts } from "./pending-operation-receipts.js";
import { installedPiChangelog } from "./pi-changelog.js";
import type { PreferencesStore } from "./preferences.js";
import {
  invalidateProjectFiles,
  listProjectDirectory,
  searchProjectFiles,
} from "./project-files.js";
import type { ProviderAuthService } from "./provider-auth.js";
import { requestError } from "./request-error.js";
import {
  checkResourceVersion,
  resourceByteRange,
  sendResourceFile,
} from "./resource-http.js";
import type { ResourceStore } from "./resources.js";
import type { RuntimeController } from "./runtime.js";
import { createRuntimeEventSockets } from "./runtime-event-sockets.js";
import type { SessionCatalogLike } from "./session-catalog.js";
import { staticWebAssets } from "./static-web-assets.js";
import {
  type NotificationPrincipal,
  TaskNotifications,
} from "./task-notifications.js";
import { createTerminalGateway } from "./terminal-gateway.js";
import type {
  TerminalConnection,
  TerminalService,
} from "./terminal-service.js";
import type {
  ToolPresentationConfigStore,
  ToolPresentationConfigurationState,
} from "./tool-presentation-config.js";
import { UpdateCoordinator } from "./update-coordinator.js";

const attachmentIdSchema = z.string().uuid();
const resourceContentSchema = z.object({
  sessionId: sessionIdField,
  download: z.literal("1").optional(),
});
const branchImageSchema = z.strictObject({
  ...historyAddress,
  targetId: z.string().min(1).max(200),
  index: z.coerce.number().int().min(0),
});
const PROMPT_OBSERVATION_WINDOW_MS = 20_000;
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 20_000;

interface AppDependencies {
  /** An HTTP observation window, never a Pi operation deadline. */
  promptObservationWindowMs?: number;
  token: string;
  /** Ready, currently owned publication; never a caller-supplied process identity. */
  instanceState?: () => InstanceState | null;
  runtime: RuntimeController;
  catalog: SessionCatalogLike;
  attachments: AttachmentStore;
  preferences: PreferencesStore;
  toolPresentations?: Pick<ToolPresentationConfigStore, "inspect">;
  resources: ResourceStore;
  git: Pick<GitInspectionService, "status" | "diff">;
  version: string;
  piVersion: string;
  /** Authenticated timer coordination; it detects installed updates and asks
   * the runtime for its short idle fence, never restarts systemd itself. */
  maintenanceRestart?: Pick<
    MaintenanceRestartController,
    "reserve" | "commit" | "release"
  >;
  hostRestart?: import("./host-restart.js").HostRestartController;
  activeHerdrMode?: boolean;
  /** Effective-at-startup Herdr state; omitted when this Host has no enhancement integration. */
  getHerdrStatus?: () => Promise<HerdrEnhancementStatus>;
  /** Already-known picker metadata; bootstrap never starts model discovery. */
  bootstrapModels?: () => BootstrapResponse["availableModels"];
  modelMetadata?: (
    cwd: string,
    refresh?: boolean,
  ) => Promise<import("./model-metadata.js").ModelMetadata>;
  modelSettings?: ModelSettingsService;
  mcpConfig?: McpConfigService;
  invalidateModels?: () => void;
  providerAuth?: ProviderAuthService;
  /** Shared update-state owner. Production supplies the persistent deployment
   * instance; test hosts default to one without checkers. */
  updateCoordinator?: UpdateCoordinator;
  distDir?: string;
  /** Complete prior asset generations retained for already-open clients. */
  developmentBrowserBuild?: string;
  requireBrowserBuild?: boolean;
  /** The persistent PTY authority. Production connects to the terminal
   * daemon; tests may supply an in-process implementation. */
  terminal?: TerminalService | Pick<TerminalConnection, "run" | "close">;
  /** Internal cadence override used by the transport liveness test. */
  websocketHeartbeatIntervalMs?: number;
}

type AuthenticatedResponse = Response<unknown, { browserId?: string }>;

function bearerToken(request: Request): string | undefined {
  const value = request.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function requestOrigin(request: Request): string {
  return canonicalOrigin(request.get("host"), request.secure);
}

function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  secure: boolean,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return url.origin === canonicalOrigin(host, secure);
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

function encodeContentDispositionName(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
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
  const contentRange = (error as { contentRange?: unknown })?.contentRange;
  if (status === 416 && typeof contentRange === "string")
    response.set("Content-Range", contentRange);
  if (status >= 500)
    console.error(`[${request.method} ${request.path}]`, error);
  // Refusals may carry machine-readable provenance and candidates the host
  // declined to choose between. Neither field contains runtime stderr.
  const matches = (error as { matches?: unknown })?.matches;
  const code = (error as { code?: unknown })?.code;
  response.status(status).json({
    error: message,
    ...(typeof code === "string" ? { code } : {}),
    ...(Array.isArray(matches) ? { matches } : {}),
    ...((error as { outcomeUnknown?: unknown })?.outcomeUnknown === true
      ? { outcomeUnknown: true }
      : {}),
  });
}

export function createInspireServer(deps: AppDependencies): {
  app: express.Express;
  server: Server;
  /** Process-lifetime prompt-delivery authority, also advertised by bootstrap. */
  authorityId: string;
  launchUrl: (origin: string) => string;
  close: () => Promise<void>;
} {
  const app = express();
  const distDir = resolve(deps.distDir ?? "dist");
  const currentBuild = currentWebBuild(distDir);
  const currentBrowserBuild = async () =>
    deps.developmentBrowserBuild ?? (await currentBuild())?.buildId;
  const browserBuildAllowed = async (claimed: string | undefined) => {
    const expected = await currentBrowserBuild();
    return expected === undefined
      ? !deps.requireBrowserBuild
      : claimed === expected;
  };
  const generatedExports = new GeneratedExportStore();
  // HTTP production behavior belongs to this application, not NODE_ENV:
  // changing the process environment also changes Pi and every tool it spawns.
  app.set("env", "production");
  const authorityId = randomUUID();
  const heartbeatIntervalMs =
    deps.websocketHeartbeatIntervalMs ?? WEBSOCKET_HEARTBEAT_INTERVAL_MS;
  const updateCoordinator =
    deps.updateCoordinator ??
    new UpdateCoordinator({ currentPiVersion: deps.piVersion });
  const pendingOperations = new PendingOperationReceipts();
  const promptOperations = new OperationReceipts<
    HostOperationResults["prompt"]
  >({
    message: "This Host has reached its process-lifetime prompt receipt limit",
    code: "PROMPT_OPERATION_CAPACITY",
  });

  async function observeOperation<Command extends HostOperationCommand>(
    command: Command,
    identity: HostOperationIdentity,
    completion: Promise<HostOperationResults[Command]>,
    response: Response,
    windowMs?: number,
  ): Promise<void> {
    const receipt = hostReceipt(command, identity);
    const completed = completion.then(
      (result): HostOperationReceipt<Command> => ({
        ...receipt,
        state: "completed",
        result,
      }),
      (error: unknown): HostOperationReceipt<Command> => {
        const detail = error as
          | (Error & {
              code?: string;
              status?: number;
              matches?: string[];
              outcomeUnknown?: boolean;
              recoveredAttachments?: UploadedAttachment[];
              recoveryId?: string;
            })
          | null;
        return {
          ...receipt,
          state: detail?.outcomeUnknown === true ? "unknown" : "rejected",
          error: {
            message:
              detail instanceof Error ? detail.message : "Operation failed",
            status: detail?.status ?? 500,
            matches: detail?.matches,
            code: detail?.code,
            recoveredAttachments: detail?.recoveredAttachments,
            recoveryId: detail?.recoveryId,
          },
        };
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disconnected: (() => void) | undefined;
    try {
      const outcome =
        windowMs === undefined
          ? await completed
          : await Promise.race([
              completed,
              new Promise<HostOperationReceipt<Command>>((resolve) => {
                disconnected = () => resolve({ ...receipt, state: "pending" });
                timer = setTimeout(disconnected, windowMs);
                response.once("close", disconnected);
              }),
            ]);
      if (!response.destroyed)
        response
          .status(
            outcome.state === "unknown" || outcome.state === "rejected"
              ? outcome.error.status
              : command === "prompt"
                ? 202
                : 200,
          )
          .json(outcome);
    } finally {
      clearTimeout(timer);
      if (disconnected) response.off("close", disconnected);
    }
  }

  const observePrompt = (
    operationId: string,
    completion: Promise<HostOperationResults["prompt"]> | null,
    response: Response,
  ) => {
    if (!completion)
      throw requestError(
        "This Host resolved that prompt operation, but its receipt retired; inspect the conversation before resending",
        409,
        { code: "PROMPT_OPERATION_RESULT_RETIRED", outcomeUnknown: true },
      );
    return observeOperation(
      "prompt",
      { operationId, authorityId },
      completion,
      response,
      deps.promptObservationWindowMs ?? PROMPT_OBSERVATION_WINDOW_MS,
    );
  };

  // The host itself remains loopback-only. A local reverse proxy may report
  // the original HTTPS protocol, but arbitrary network hops never gain trust.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  const routes = hostEndpoints;

  app.use((_request, response, next) => {
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
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss:",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join("; "),
    });
    next();
  });
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  // JSON escapes can take six bytes per character of a valid prompt.
  app.post(INPUT_OPERATION_PATHS.prompt, express.json({ limit: "4mb" }));
  app.use(express.json({ limit: "2mb" }));
  const browserAuth = new BrowserAuth(deps.token);
  const taskNotifications = new TaskNotifications(
    `${deps.preferences.path}.notifications-${browserAuth.notificationNamespace()}.json`,
    undefined,
    (id) => deps.catalog.get(id, { refresh: true }),
  );
  deps.runtime.on("task_outcome", taskNotifications.observe);
  const launchUrl = (origin: string): string =>
    `${origin}/#inspire-bootstrap=${browserAuth.bootstrap(origin)}`;
  app.get("/html-preview/:id/*path", (request, response) =>
    serveHtmlPreview(
      deps.resources,
      (sessionId) => deps.runtime.resourceContext(sessionId),
      request,
      response,
    ),
  );

  app.use("/api", (request, response, next) => {
    if (
      !originAllowed(request.get("origin"), request.get("host"), request.secure)
    )
      return response.status(403).json({ error: "Origin is not allowed" });
    next();
  });
  // Registration is the only browser exchange that accepts the master token.
  // Require an exact Origin even for read-like authentication POSTs.
  app.use("/api/auth", (request, response, next) => {
    if (request.get("origin") !== requestOrigin(request))
      return response
        .status(403)
        .json({ error: "An exact browser Origin is required" });
    next();
  });
  app.post("/api/auth/pair", (request, response) => {
    response.json(
      browserAuth.register(
        requestOrigin(request),
        registrationSchema.parse(request.body),
      ),
    );
  });
  app.post("/api/auth/challenge", (request, response) => {
    const { certificate } = challengeSchema.parse(request.body);
    response.json(browserAuth.challenge(requestOrigin(request), certificate));
  });
  app.post("/api/auth/exchange", (request, response) => {
    const { challenge, signature } = exchangeSchema.parse(request.body);
    response.json(
      browserAuth.exchange(requestOrigin(request), challenge, signature),
    );
  });

  const localControl = new InstanceHttpControl();
  const maintenanceLeaseSchema = z.object({
    leaseId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  });
  // CLI peers prove only one fresh action and authenticate the signed result.
  // Neither readiness nor maintenance sends the reusable Host bearer to a
  // possibly replaced listener. Ordinary explicit-bearer APIs remain separate.
  app.post("/api/host/local-control", async (request, response) => {
    const state = deps.instanceState?.();
    if (!state || state.token !== deps.token)
      return response
        .status(503)
        .json({ error: "Local control is unavailable" });
    const grant = localControl.accept(state, request.body);
    if (!grant)
      return response
        .status(401)
        .json({ error: "Local control proof is invalid" });
    let result: unknown;
    switch (grant.request.action) {
      case "readiness":
        result = { appName: "inspire" };
        break;
      case "restart-mode":
        result = { includeHerdr: deps.activeHerdrMode === true };
        break;
      case "launch-url": {
        let origin = new URL(instanceUrl(state)).origin;
        if (grant.request.payload.origin !== undefined) {
          const candidate = z
            .string()
            .max(512)
            .url()
            .parse(grant.request.payload.origin);
          const target = new URL(candidate);
          if (
            target.origin !== candidate ||
            target.protocol !== "http:" ||
            !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)
          )
            throw requestError(
              "A canonical loopback browser origin is required",
              400,
            );
          origin = target.origin;
        }
        result = { url: launchUrl(origin) };
        break;
      }
      case "maintenance-prepare":
        result = deps.maintenanceRestart
          ? await deps.maintenanceRestart.reserve()
          : { kind: "skipped", reason: "runtime-unsupported" };
        break;
      case "maintenance-commit":
      case "maintenance-release": {
        const { leaseId } = maintenanceLeaseSchema.parse(grant.request.payload);
        result = (grant.request.action === "maintenance-commit"
          ? deps.maintenanceRestart?.commit(leaseId)
          : deps.maintenanceRestart?.release(leaseId)) ?? {
          kind: "skipped",
          reason: "runtime-unsupported",
        };
        break;
      }
    }
    response.json(localControl.reply(grant, result));
  });

  // Native downloads cannot carry Authorization. A narrowly scoped one-use
  // capability preserves streaming, with no file bytes buffered in JavaScript.
  app.get("/api/resource-downloads/:ticket", async (request, response) => {
    const origin = requestOrigin(request);
    if (
      !downloadOriginAllowed(origin, {
        origin: request.get("origin"),
        fetchSite: request.get("sec-fetch-site"),
        referer: request.get("referer"),
      })
    )
      return response
        .status(403)
        .json({ error: "An exact browser origin is required" });
    const grant = browserAuth.consumeDownload(request.params.ticket, origin);
    await sendResourceContent(
      request,
      response,
      grant.resourceId,
      grant.sessionId,
      true,
    );
  });

  app.use("/api", (request, response, next) => {
    const bearer = bearerToken(request);
    if (tokenMatches(bearer, deps.token)) return next();
    const access = browserAuth.verifyAccess(bearer, requestOrigin(request));
    if (!access)
      return response.status(401).json({ error: "Authentication required" });
    response.locals.browserId = access.browserId;
    next();
  });
  app.use("/api", async (request, response, next) => {
    // Explicit non-browser bearer clients use their own request contract.
    if (
      !response.locals.browserId ||
      (await browserBuildAllowed(request.get(BROWSER_BUILD_HEADER)))
    )
      return next();
    response
      .set(BROWSER_BUILD_HEADER, BROWSER_UPGRADE_REQUIRED)
      .status(409)
      .json({
        code: BROWSER_UPGRADE_REQUIRED,
        error: "Reload this page to use the current Inspire build.",
      });
  });
  app.post(
    "/api/auth/socket-ticket",
    (request, response: AuthenticatedResponse) => {
      const { audience } = socketTicketSchema.parse(request.body);
      response.json(
        browserAuth.ticket(
          requestOrigin(request),
          audience,
          response.locals.browserId,
        ),
      );
    },
  );

  const notificationPrincipal = (
    request: Request,
    response: AuthenticatedResponse,
  ): NotificationPrincipal => {
    const origin = requestOrigin(request);
    if (
      !downloadOriginAllowed(origin, {
        origin: request.get("origin"),
        fetchSite: request.get("sec-fetch-site"),
        referer: request.get("referer"),
      })
    )
      throw requestError("An exact browser origin is required", 403);
    const id = response.locals.browserId;
    if (!id)
      throw requestError(
        "Refresh browser authentication to configure notifications",
        401,
      );
    return { id, origin };
  };
  jsonRoute(app, routes.taskAlertSettings, (_input, request, response) =>
    taskNotifications.settings(notificationPrincipal(request, response)),
  );
  jsonRoute(app, routes.configureTaskAlerts, ({ body }, request, response) =>
    taskNotifications.configure(
      notificationPrincipal(request, response),
      body.mode,
      body.subscription,
      body.grouping,
    ),
  );
  jsonRoute(
    app,
    routes.acknowledgeTaskAlert,
    async ({ body }, request, response) => {
      await taskNotifications.acknowledge(
        notificationPrincipal(request, response),
        body.id,
      );
      return { ok: true };
    },
  );
  jsonRoute(app, routes.testTaskAlert, (_input, request, response) =>
    taskNotifications.test(notificationPrincipal(request, response)),
  );

  app.get("/api/health", (_request, response) => {
    response.json({ appName: "inspire" });
  });

  jsonRoute(app, routes.herdrStatus, async () => {
    if (!deps.getHerdrStatus)
      throw requestError(
        "Herdr enhancement status is unavailable for this Host.",
        503,
      );
    return deps.getHerdrStatus();
  });

  jsonRoute(app, routes.hostRestartStatus, async () =>
    deps.hostRestart
      ? deps.hostRestart.status()
      : {
          hostId: authorityId,
          available: false,
          allPiAvailable: false,
          allPiReason: "Restart all is unavailable for this Host.",
          reason: "Page restart is unavailable for this Host.",
          operation: null,
        },
  );
  jsonRoute(app, routes.restartHost, ({ body: intent }, _request, response) => {
    if (!deps.hostRestart)
      throw requestError("Page restart is unavailable for this Host.", 503);
    response.status(202);
    return restartObservation(intent, deps.hostRestart.start(intent));
  });

  const terminalGateway = createTerminalGateway(
    app,
    deps.terminal,
    heartbeatIntervalMs,
    currentBrowserBuild,
  );

  jsonRoute(app, routes.update, async ({ query }) => {
    const updateStatus = await updateCoordinator.checkInspire(
      query.refresh === "1",
    );
    return {
      ...(updateStatus.inspireUpdateCheck ?? { kind: "unavailable" as const }),
      updateStatus,
    };
  });

  jsonRoute(app, routes.piUpdate, async ({ query }) => {
    const updateStatus = await updateCoordinator.checkPi(query.refresh === "1");
    return {
      ...(updateStatus.piUpdateCheck ?? {
        currentVersion: deps.piVersion,
        installedVersion: null,
        pi: { kind: "unavailable" as const },
        extensions: { kind: "unavailable" as const },
      }),
      updateStatus,
    };
  });

  jsonRoute(app, routes.snoozeUpdate, ({ body }) =>
    updateCoordinator.dismiss(body.identity),
  );

  jsonRoute(app, routes.bootstrap, async (_input, _request, response) => {
    const startedAt = performance.now();
    const preferenceRead = deps.preferences.inspect();
    const [preferenceState, toolPresentationState, updateStatus] =
      await Promise.all([
        preferenceRead,
        preferenceRead.then(({ preferences }) =>
          deps.toolPresentations
            ? deps.toolPresentations.inspect(preferences.adapterEnabled)
            : Promise.resolve<ToolPresentationConfigurationState>({
                configuration: emptyToolPresentationConfiguration(),
              }),
        ),
        updateCoordinator.status(),
      ]);
    const body: BootstrapResponse = {
      appName: "inspire",
      authorityId,
      startupSessionId: deps.runtime.startupSessionHint,
      version: deps.version,
      piVersion: deps.piVersion,
      updateStatus,
      preferences: preferenceState.preferences,
      preferenceRevision: preferenceState.revision,
      ...(preferenceState.warning
        ? { preferencesWarning: preferenceState.warning }
        : {}),
      toolPresentations: toolPresentationState.configuration,
      ...(toolPresentationState.adapters
        ? { presentationAdapters: toolPresentationState.adapters }
        : {}),
      ...(toolPresentationState.warning
        ? { toolPresentationsWarning: toolPresentationState.warning }
        : {}),
      availableModels: deps.bootstrapModels?.() ?? [],
    };
    response.set(
      "Server-Timing",
      `inspire-bootstrap;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    return body;
  });

  jsonRoute(
    app,
    routes.sessions,
    ({ query: { q, offset, limit } }, request, response) =>
      withRequestSignal(request, response, (signal) =>
        deps.catalog.list({ query: q, offset, limit, signal }),
      ),
  );
  jsonRoute(app, routes.refreshSessions, async () => {
    await deps.catalog.refresh(true);
    return { ok: true };
  });
  jsonRoute(app, routes.sessionsByIds, async ({ body }) => ({
    sessions: await deps.catalog.listByIds(body.ids),
  }));
  jsonRoute(app, routes.sessionsByCwds, async ({ body }) => ({
    sessions: await deps.catalog.listByCwds(body.cwds),
  }));
  jsonRoute(app, routes.openSession, ({ body }) =>
    deps.runtime.openSession(body.id),
  );
  jsonRoute(app, routes.deselectSession, () => deps.runtime.deselectSession());
  jsonRoute(app, routes.newSession, ({ body: { cwd, ...options } }) =>
    deps.runtime.newSession(cwd, options),
  );
  registerModelSettingsRoutes(app, deps);
  registerMcpConfigRoutes(app, deps);
  jsonRoute(
    app,
    routes.refreshModels,
    async ({ query: { sessionId, cwd: requestedCwd, inherit } }) => {
      const cwd = requestedCwd
        ? await resolveProjectDirectory(requestedCwd)
        : process.cwd();
      const result: NativeModelCatalog = sessionId
        ? await deps.runtime.refreshModels(sessionId, inherit === "1")
        : ((await deps.modelMetadata?.(cwd, true)) ?? { models: [] });
      const { models, commands, defaults, selection, warning } = result;
      const catalogCwd = sessionId ? deps.runtime.sessionCwd(sessionId) : cwd;
      const preferences =
        result.enabledModelPatterns === undefined && catalogCwd && models.length
          ? await deps.modelSettings?.readCatalogPreferences(catalogCwd)
          : undefined;
      return {
        models,
        commands,
        defaults,
        selection,
        warning,
        thinkingPreferences:
          result.thinkingPreferences ?? preferences?.thinkingPreferences,
        commonModels: await commonModelOptions(
          result.enabledModelPatterns ??
            preferences?.enabledModelPatterns ??
            [],
          models,
        ),
      };
    },
  );
  jsonRoute(
    app,
    routes.searchNewSessionFiles,
    async ({ query: { cwd, q, limit, showHidden } }) => {
      const root = await resolveProjectDirectory(cwd);
      return {
        cwd: root,
        ...(await searchProjectFiles(root, q, limit, showHidden)),
      };
    },
  );
  jsonRoute(app, routes.renameSession, async ({ body }) => {
    await deps.runtime.rename(body.sessionId, body.name);
    return { ok: true };
  });
  jsonRoute(
    app,
    routes.deleteSessions,
    async ({ body }): Promise<SessionDeletionResponse> => {
      const { preferences, revision } = await deps.preferences.inspect();
      const projectCwd = body.scope === "hidden" ? body.projectCwd : undefined;
      if (
        projectCwd !== undefined &&
        !preferences.hiddenProjectCwds.includes(projectCwd)
      )
        throw requestError(
          "The folder is no longer hidden; review it before deleting",
          409,
          {
            code: "HIDDEN_SELECTION_CHANGED",
          },
        );
      const curation =
        projectCwd === undefined
          ? preferences
          : { hiddenSessionIds: [], hiddenProjectCwds: [projectCwd] };
      const result = await deps.runtime.deleteSessions(body, curation);
      const deletedIds = result.deleted.map(({ sessionId }) => sessionId);
      for (const id of deletedIds) deps.resources.forgetSession(id);
      try {
        const publication = deletedIds.length
          ? await deps.preferences.removeDeletedSessions(
              deletedIds,
              body.scope === "hidden" && !result.failure ? curation : undefined,
            )
          : { preferences, revision };
        return {
          ...result,
          navigation: { kind: "confirmed", authorityId, ...publication },
        };
      } catch (error) {
        console.error(
          "[session deletion] navigation metadata cleanup failed",
          error,
        );
        return {
          ...result,
          navigation: {
            kind: "unavailable",
            reason:
              "Deletion completed, but its navigation metadata could not be saved",
          },
        };
      }
    },
  );

  const upload = multer({
    defParamCharset: "utf8",
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
  app.get("/api/attachments/:id/image", async (request, response) => {
    const image = await deps.attachments.imagePreview(
      attachmentIdSchema.parse(request.params.id),
    );
    response.type(image.mimeType).send(image.bytes);
  });
  jsonRoute(app, routes.deleteAttachment, async ({ params: { id } }) => {
    await deps.attachments.remove(id);
    return { ok: true };
  });

  app.post(INPUT_OPERATION_PATHS.prompt, async (request, response) => {
    // Lets the browser distinguish a definitive Host refusal from an
    // intermediary 5xx whose delivery outcome remains unknown.
    const prompt = promptSchema.parse(request.body);
    if (prompt.authorityId !== authorityId)
      throw requestError(
        "The Host restarted before this prompt delivery could be confirmed",
        409,
        { code: "HOST_AUTHORITY_CHANGED" },
      );

    const fingerprint = createHash("sha256")
      .update(promptFingerprintInput(prompt))
      .digest("hex");
    const operation = promptOperations.get(prompt.operationId);
    if (operation && operation.fingerprint !== fingerprint)
      throw requestError(
        "That prompt operation ID was reused with different content",
        409,
        { code: "PROMPT_OPERATION_MISMATCH" },
      );
    const completion = operation
      ? operation.result
      : promptOperations.start(prompt.operationId, fingerprint, async () => {
          const {
            operationId: _operationId,
            authorityId: _authorityId,
            ...input
          } = prompt;
          const historyEntry = await deps.runtime.prompt(input);
          void updateCoordinator.promptAccepted();
          return historyEntry;
        });
    await observePrompt(prompt.operationId, completion, response);
  });
  app.get(
    `${INPUT_OPERATION_PATHS.prompt}/:operationId`,
    async (request, response) => {
      const {
        operationId,
        authorityId: expected,
        fingerprint,
      } = promptObservationSchema.parse({
        operationId: request.params.operationId,
        authorityId: request.query.authorityId,
        fingerprint: request.query.fingerprint,
      });
      if (expected !== authorityId)
        throw requestError("The prompt receipt belongs to another Host", 409, {
          code: "HOST_AUTHORITY_CHANGED",
          outcomeUnknown: true,
        });
      const operation = promptOperations.get(operationId);
      if (!operation)
        throw requestError(
          "This Host cannot identify that prompt receipt",
          409,
          {
            code: "PROMPT_OPERATION_NOT_FOUND",
            outcomeUnknown: true,
          },
        );
      if (fingerprint !== undefined && fingerprint !== operation.fingerprint)
        throw requestError(
          "The prompt receipt belongs to different content",
          409,
          {
            code: "PROMPT_OPERATION_MISMATCH",
            outcomeUnknown: true,
          },
        );
      await observePrompt(operationId, operation.result, response);
    },
  );
  jsonRoute(app, routes.piChangelog, installedPiChangelog);
  jsonRoute(app, routes.takeOverSession, ({ body }) =>
    deps.runtime.takeOverSession(body.sessionId),
  );
  /** A command that resumes this session in a terminal Pi. Copying it changes
   * nothing: Inspire and terminal Pi instances can share a session. */
  jsonRoute(app, routes.resumeCommand, async ({ query: { sessionId } }) => {
    const session = await deps.catalog.get(sessionId);
    if (!session) throw requestError("Session not found", 404);
    const quote = (value: string) =>
      "'" +
      value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") +
      "'";
    const command = `pi --session ${quote(session.path)}`;
    const projectDirectoryMissing = await resolveProjectDirectory(
      session.cwd,
    ).then(
      () => false,
      (error: NodeJS.ErrnoException) =>
        error?.code === "PROJECT_DIRECTORY_MISSING",
    );
    const changeDirectory =
      process.platform === "win32" ? "Set-Location -LiteralPath" : "cd --";
    return projectDirectoryMissing
      ? { command, projectDirectoryMissing }
      : { command: `${changeDirectory} ${quote(session.cwd)} && ${command}` };
  });
  jsonRoute(app, routes.exportSession, ({ body: { sessionId, format } }) =>
    generatedExports.create(sessionId, format, (path) =>
      deps.runtime.nativeCommand({
        sessionId,
        command: "export",
        argument: `"${path}"`,
      }),
    ),
  );
  app.get(
    "/api/sessions/:sessionId/exports/:exportId",
    async (request, response, next) => {
      const file = await generatedExports.get(
        sessionIdField.parse(request.params.sessionId),
        z.string().uuid().parse(request.params.exportId),
      );
      response.download(
        file.path,
        file.fileName,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
          },
        },
        (error) => {
          if (error) next(error);
        },
      );
    },
  );
  jsonRoute(app, routes.nativeCommand, async ({ body: command }) => {
    const result = await deps.runtime.nativeCommand(command);
    if (result.export) {
      try {
        Object.assign(
          result.export,
          await generatedExports.add(
            command.sessionId,
            result.export.path,
            result.export.format,
          ),
        );
      } catch (error) {
        result.details = [
          ...(result.details ?? []),
          {
            label: "Download unavailable",
            value:
              error instanceof Error
                ? error.message
                : "Export again to download",
          },
        ];
      }
    }
    return result;
  });
  const assertPendingAuthority = (expected: string): void => {
    if (expected !== authorityId)
      throw requestError("The Pending operation belongs to another Host", 409, {
        code: "HOST_AUTHORITY_CHANGED",
        outcomeUnknown: true,
      });
  };
  const pendingResponse = (
    recovered: Awaited<ReturnType<RuntimeController["recoverPending"]>>,
  ) => ({
    ...recovered,
    ...(recovered.attachments?.length ? { authorityId } : {}),
  });
  app.get(
    `${INPUT_OPERATION_PATHS.pending}/:operationId`,
    async (request, response) => {
      const operation = pendingOperationRequestSchema.parse({
        ...request.query,
        operationId: request.params.operationId,
      });
      assertPendingAuthority(operation.authorityId);
      await observeOperation(
        operation.action,
        operation,
        pendingOperations.observe(operation).then(pendingResponse),
        response,
      );
    },
  );
  for (const [path, action] of [
    [INPUT_OPERATION_PATHS.abort, "abort"],
    [INPUT_OPERATION_PATHS.recover, "recover"],
  ] as const) {
    app.post(path, async (request, response) => {
      const operation = pendingOperationSchema.parse(request.body);
      assertPendingAuthority(operation.authorityId);
      const completion = pendingOperations.run({ ...operation, action }, () =>
        action === "abort"
          ? deps.runtime.abort(operation.sessionId, operation.expectedViewId)
          : deps.runtime.recoverPending(
              operation.sessionId,
              operation.expectedViewId,
            ),
      );
      await observeOperation(
        action,
        operation,
        completion.then(pendingResponse),
        response,
      );
    });
  }
  jsonRoute(app, routes.pendingText, ({ body }) =>
    deps.runtime.pendingText(body),
  );
  jsonRoute(app, routes.clearPending, async ({ body }) => {
    await deps.runtime.clearPending(body.sessionId);
    return { ok: true };
  });
  jsonRoute(
    app,
    routes.cycleModel,
    async ({ body: { sessionId, direction } }) => {
      if (direction !== 1)
        throw requestError(
          "This Pi version exposes only forward model cycling over RPC. Select a model in the picker instead.",
          409,
          { code: "PI_CAPABILITY_UNAVAILABLE" },
        );
      return (await deps.runtime.cycleModel(sessionId)) ?? null;
    },
  );
  jsonRoute(app, routes.setModel, ({ body }) =>
    deps.runtime.setModel(body.sessionId, body.provider, body.modelId),
  );
  jsonRoute(app, routes.setThinkingLevel, ({ body }) =>
    deps.runtime.setThinkingLevel(body.sessionId, body.level),
  );
  for (const [route, apply] of [
    [routes.setAutoCompaction, "setAutoCompaction"],
    [routes.setAutoRetry, "setAutoRetry"],
  ] as const) {
    jsonRoute(app, route, async ({ body }) => {
      await deps.runtime[apply](body.sessionId, body.enabled);
      return { ok: true };
    });
  }
  for (const [route, apply] of [
    [routes.setSteeringMode, "setSteeringMode"],
    [routes.setFollowUpMode, "setFollowUpMode"],
  ] as const) {
    jsonRoute(app, route, async ({ body }) => {
      await deps.runtime[apply](body.sessionId, body.mode);
      return { ok: true };
    });
  }
  jsonRoute(app, routes.respondExtensionUi, async ({ body }) => {
    await deps.runtime.extensionUiResponse(body);
    return { ok: true };
  });

  const openSessionCwd = (sessionId: string): string => {
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd) throw requestError("That session is not open on this host", 409);
    return cwd;
  };

  jsonRoute(
    app,
    routes.searchFiles,
    ({ query: { sessionId, q, limit, showHidden } }) =>
      searchProjectFiles(openSessionCwd(sessionId), q, limit, showHidden),
  );
  jsonRoute(
    app,
    routes.listFiles,
    ({ query: { sessionId, dir, refresh, showHidden } }) => {
      const cwd = openSessionCwd(sessionId);
      if (refresh) invalidateProjectFiles(cwd);
      return listProjectDirectory(cwd, dir, showHidden);
    },
  );
  jsonRoute(app, routes.gitStatus, ({ query }, request, response) =>
    withRequestSignal(request, response, (signal) =>
      deps.git.status(openSessionCwd(query.sessionId), signal),
    ),
  );
  jsonRoute(app, routes.gitDiff, ({ body }, request, response) =>
    withRequestSignal(request, response, (signal) =>
      deps.git.diff(openSessionCwd(body.sessionId), body.pathId, signal),
    ),
  );

  jsonRoute(app, routes.browseHostRoots, () => listHostRoots());
  jsonRoute(
    app,
    routes.browseHostDirs,
    async ({ query: { path, showHidden } }) => {
      if (path && !isAbsolute(path))
        throw requestError("path must be absolute", 400);
      try {
        return await listHostDirectories(path, showHidden);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR")
          throw requestError("No such directory on the host", 404);
        if (code === "EACCES" || code === "EPERM")
          throw requestError("The host cannot read that directory", 403);
        throw error;
      }
    },
  );

  jsonRoute(app, routes.listResources, async ({ body: { sessionId } }) => {
    const context = await deps.runtime.resourceContext(sessionId);
    return {
      sessionId,
      viewId: context.viewId,
      revision: context.revision,
      ...(await deps.resources.list(context)),
    };
  });
  jsonRoute(
    app,
    routes.probeResources,
    async ({ body: { sessionId, references } }) => {
      const context = await deps.runtime.resourceContext(sessionId);
      return {
        sessionId,
        viewId: context.viewId,
        revision: context.revision,
        results: await deps.resources.probe(context, references),
      };
    },
  );
  jsonRoute(
    app,
    routes.resolveResource,
    async ({ body: { sessionId, reference, workspacePath } }) => {
      const context = await deps.runtime.resourceContext(sessionId);
      return deps.resources.resolve(context, reference, workspacePath);
    },
  );
  jsonRoute(
    app,
    routes.showInFileManager,
    async ({ body: { sessionId, reference, workspacePath, directory } }) => {
      const context = await deps.runtime.resourceContext(sessionId);
      const path = await deps.resources.fileManagerPath(
        context,
        reference,
        workspacePath,
        directory,
      );
      await showInFileManager(path, directory);
      return { ok: true };
    },
  );
  jsonRoute(
    app,
    routes.createHtmlPreview,
    async (
      { params: { id }, body: { sessionId, html } },
      _request,
      response,
    ) => {
      const context = await deps.runtime.resourceContext(sessionId);
      const preview = await deps.resources.createHtmlPreview(id, context, html);
      if (response.destroyed)
        deps.resources.removeHtmlPreview(preview.id, sessionId);
      return preview;
    },
  );
  jsonRoute(
    app,
    routes.deleteHtmlPreview,
    ({ params: { id }, query: { sessionId } }) => {
      deps.resources.removeHtmlPreview(id, sessionId);
    },
  );
  jsonRoute(
    app,
    routes.resourceDownloadTicket,
    async ({ params: { id }, body: { sessionId } }, request) => {
      const context = await deps.runtime.resourceContext(sessionId);
      await deps.resources.revalidate(
        deps.resources.get(id, sessionId, context.viewId),
        context,
      );
      return browserAuth.downloadTicket(requestOrigin(request), id, sessionId);
    },
  );
  app.get("/api/resources/:id/content", async (request, response) => {
    const { sessionId, download } = resourceContentSchema.parse(request.query);
    await sendResourceContent(
      request,
      response,
      request.params.id,
      sessionId,
      download === "1",
    );
  });
  async function sendResourceContent(
    request: Request,
    response: Response,
    resourceId: string,
    sessionId: string,
    download: boolean,
  ): Promise<void> {
    let closed = response.destroyed;
    response.once("close", () => {
      closed = true;
    });
    // Handles are bound to the opaque branch view that authorized them. The
    // current authority is rechecked before any headers or bytes are sent.
    const context = await deps.runtime.resourceContext(sessionId);
    const resource = deps.resources.get(resourceId, sessionId, context.viewId);
    await deps.resources.revalidate(resource, context);
    if (closed || response.destroyed) return;
    const setResourceHeaders = (
      mimeType = resource.descriptor.mimeType,
    ): void => {
      response.set({
        "Content-Type": mimeType,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeContentDispositionName(resource.descriptor.name)}`,
      });
    };
    if (resource.authority === "embedded") {
      const { data, mimeType } = await deps.resources.embeddedContent(
        resource,
        context,
      );
      if (closed || response.destroyed) return;
      const version =
        '"' + createHash("sha256").update(data).digest("base64url") + '"';
      checkResourceVersion(request, version);
      const range = resourceByteRange(request, data.length);
      setResourceHeaders(mimeType);
      response.set({ "Accept-Ranges": "bytes", ETag: version });
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
      const opened = await deps.resources.openForServing(resource);
      await sendResourceFile(request, response, opened, setResourceHeaders);
    } else {
      response
        .status(404)
        .json({ error: "The resource preview is no longer available" });
    }
  }

  jsonRoute(
    app,
    routes.setPresentationAdapterEnabled,
    async ({ params: { id }, body: { enabled } }) => {
      const current = await deps.toolPresentations?.inspect();
      if (!current?.adapters?.some((adapter) => adapter.id === id))
        throw requestError("The adapter is not configured", 404);
      const { preferences, revision } = await deps.preferences.patch({
        adapterEnabled: { [id]: enabled },
      });
      const state = await deps.toolPresentations!.inspect(
        preferences.adapterEnabled,
      );
      return { ...state, preferences, preferenceRevision: revision };
    },
  );

  jsonRoute(app, routes.preferences, async () => {
    const { preferences, revision } = await deps.preferences.inspect();
    return { preferences, revision };
  });
  jsonRoute(app, routes.savePreferences, async ({ body }) => {
    const publication = await deps.preferences.patch(body);
    if (body.pinnedProjectCwds || body.hiddenProjectCwds)
      deps.catalog.invalidate();
    return publication;
  });
  jsonRoute(app, routes.snapshot, ({ query: { detail } }) =>
    deps.runtime.snapshot(detail === "" ? null : detail),
  );
  jsonRoute(
    app,
    routes.sessionHistory,
    ({ query: { sessionId, viewId, ...query } }) =>
      deps.runtime.sessionHistory(sessionId, viewId, query),
  );
  jsonRoute(app, routes.lastAssistantText, ({ query }) =>
    deps.runtime.lastAssistantText(query.sessionId, query.viewId),
  );
  app.get("/api/branches/image", async (request, response) => {
    const { index, ...address } = branchImageSchema.parse(request.query);
    const image = await deps.runtime.branchImage(address, index);
    response.setHeader("Cache-Control", "private, no-store");
    response.type(
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        image.mimeType,
      )
        ? image.mimeType
        : "application/octet-stream",
    );
    response.send(image.data);
  });
  jsonRoute(app, routes.cloneBranch, ({ body }) =>
    deps.runtime.cloneBranch(body),
  );
  jsonRoute(app, routes.navigateBranch, ({ body }) =>
    deps.runtime.navigateBranch(body),
  );
  jsonRoute(app, routes.forkBranch, ({ body }) =>
    deps.runtime.forkBranch(body),
  );

  // Unknown API paths are protocol errors, never client-side routes. Keep
  // them out of the SPA fallback so a typo cannot return index.html as 200.
  app.all(["/api", "/api/*path"], (_request, response) => {
    response.status(404).json({ error: "API route not found" });
  });

  if (existsSync(distDir)) {
    app.use("/assets", staticWebAssets(join(distDir, "assets"), currentBuild));
    // A missing module is an asset error, never a client-side route. Returning
    // index.html here both hides the cause and lets a Service Worker cache HTML
    // under a JavaScript URL.
    app.use("/assets", (_request, response) => {
      response
        .set("Cache-Control", "no-store")
        .status(404)
        .type("text/plain")
        .send("Static asset not found");
    });
    // Every other dist file is unhashed — theme-init.js, index.html — so it
    // must revalidate, or a rebuild is served stale for up to a year.
    app.use(
      express.static(distDir, { index: false, fallthrough: true, maxAge: 0 }),
    );
    app.get("*path", (_request, response) => {
      response.set("Cache-Control", "no-cache");
      response.sendFile("index.html", { root: distDir });
    });
  }

  app.use(apiError);
  const server = createServer(app);
  const runtimeEvents = createRuntimeEventSockets({
    runtime: deps.runtime,
    updateCoordinator,
    authorityId,
    heartbeatIntervalMs,
    currentBrowserBuild,
    taskNotifications,
  });

  server.on("upgrade", (request, socket, head) => {
    void upgrade(request, socket, head).catch(() => socket.destroy());
  });
  async function upgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) {
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
    let origin: string;
    try {
      origin = canonicalOrigin(
        request.headers.host,
        trustedForwardedHttps(request),
      );
    } catch {
      socket.destroy();
      return;
    }
    const audience = url.pathname.slice(1);
    const browserAuthenticated =
      request.headers.origin === origin &&
      browserAuth.consumeTicketGrant(
        url.searchParams.get("ticket"),
        origin,
        audience,
      );
    // Trusted non-browser clients can supply an explicit header, never a URL
    // token. Browsers must use exact-origin, audience-bound single-use tickets.
    const explicitAuthenticated =
      request.headers.origin === undefined &&
      tokenMatches(
        request.headers.authorization?.startsWith("Bearer ")
          ? request.headers.authorization.slice(7)
          : undefined,
        deps.token,
      );
    const browserBuild = url.searchParams.get("build") ?? undefined;
    if (browserAuthenticated && !(await browserBuildAllowed(browserBuild))) {
      if (url.pathname === "/events")
        runtimeEvents.rejectUpgrade(request, socket, head);
      else if (url.pathname === "/terminal" && deps.terminal)
        terminalGateway.rejectUpgrade(request, socket, head);
      else socket.destroy();
      return;
    }
    if (url.pathname === "/terminal" && deps.terminal && browserAuthenticated) {
      terminalGateway.upgrade(request, socket, head, browserBuild);
      return;
    }
    if (
      url.pathname === "/events" &&
      (browserAuthenticated || explicitAuthenticated)
    ) {
      runtimeEvents.upgrade(
        request,
        socket,
        head,
        url,
        browserAuthenticated && browserAuthenticated.browserId
          ? { id: browserAuthenticated.browserId, origin }
          : undefined,
        browserAuthenticated ? browserBuild : undefined,
      );
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  return {
    app,
    server,
    authorityId,
    launchUrl,
    close: async () => {
      deps.providerAuth?.close();
      // Stop accepting HTTP/upgrades first, but do not await the drain before
      // runtime teardown: an active request may itself be waiting on runtime.
      const drained = server.listening
        ? new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
          })
        : Promise.resolve();
      runtimeEvents.close();
      deps.runtime.off("task_outcome", taskNotifications.observe);
      await taskNotifications.close();
      terminalGateway.close();
      const runtimeResult = await deps.runtime.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      server.closeIdleConnections();
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      // HTTP's closeAllConnections excludes upgraded sockets. They have had
      // their normal close notification and runtime teardown opportunity; a
      // missing peer acknowledgement must not extend the Host's network drain.
      const upgradedDrained = Promise.all([
        runtimeEvents.terminateRemaining(),
        terminalGateway.terminateRemaining(),
      ]);
      server.closeAllConnections();
      await upgradedDrained;
      const drainedResult = await drained.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const terminalResult = await (
        deps.terminal?.close() ?? Promise.resolve()
      ).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      deps.resources.close();
      const exportResult = await generatedExports.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const attachmentResult = await deps.attachments.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const updateResult = await updateCoordinator.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const failures = [
        runtimeResult,
        drainedResult,
        terminalResult,
        exportResult,
        attachmentResult,
        updateResult,
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
