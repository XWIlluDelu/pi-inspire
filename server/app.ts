import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
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
import { MAX_ASSISTANT_STREAM_BATCH_EVENTS } from "../shared/assistant-stream.js";
import {
  type BootstrapResponse,
  type GitDiffSide,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENTS,
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_CURATED_SESSION_RESULTS,
  MAX_PENDING_MESSAGES,
  MAX_PROJECT_FILES,
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type NewSessionDefaults,
  THINKING_LEVELS,
} from "../shared/contracts.js";
import {
  MAX_RESOURCE_LIST_PAGE_SIZE,
  MAX_RESOURCE_PROBE_REFERENCES,
  RESOURCE_LIST_INITIAL_SIZE,
} from "../shared/resource-references.js";
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
} from "../shared/terminal-contracts.js";
import { emptyToolPresentationConfiguration } from "../shared/tool-presentation-config.js";
import type { AttachmentStore } from "./attachments.js";
import type { GitInspectionLike } from "./git-inspection.js";
import { listHostDirectories, listHostRoots } from "./host-dirs.js";
import type { MaintenanceRestartOutcome } from "./maintenance-restart.js";
import { resolveProjectDirectory } from "./paths.js";
import type { PiUpdateCheckerLike } from "./pi-update-checker.js";
import type { PreferencesStore } from "./preferences.js";
import {
  invalidateProjectIndex,
  listProjectDirectory,
  searchProjectFiles,
} from "./project-files.js";
import { requestError } from "./request-error.js";
import type { ResourceStore } from "./resources.js";
import type { RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike } from "./session-catalog.js";
import type {
  TerminalAttachment,
  TerminalService,
} from "./terminal-service.js";
import type {
  ToolPresentationConfigLike,
  ToolPresentationConfigurationState,
} from "./tool-presentation-config.js";
import type { UpdateCheckerLike } from "./update-checker.js";
import {
  UpdateCoordinator,
  type UpdateCoordinatorLike,
} from "./update-coordinator.js";

const pairSchema = z.object({ token: z.string().min(1).max(256) }).strict();
const updateSnoozeSchema = z
  .object({
    identity: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
const openSchema = z.object({
  id: z.string().min(1).max(MAX_SESSION_ID_CHARS),
});
const deleteSessionParamsSchema = z.object({
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
});
const clearHiddenSchema = z
  .object({
    sessionIds: z
      .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
      .min(1)
      .max(MAX_CURATED_SESSION_RESULTS),
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
const sessionIdField = z.string().min(1).max(MAX_SESSION_ID_CHARS);
const promptSchema = z
  .object({
    operationId: z.string().uuid(),
    authorityId: z.string().uuid(),
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
const nativeCommandSchema = z
  .object({
    sessionId: sessionIdField,
    command: z.enum(["compact", "export", "reload"]),
    argument: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .strict();
const runtimeBooleanSchema = z
  .object({
    sessionId: sessionIdField,
    enabled: z.boolean(),
  })
  .strict();
const runtimeDeliveryModeSchema = z
  .object({
    sessionId: sessionIdField,
    mode: z.enum(["all", "one-at-a-time"]),
  })
  .strict();
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
  ids: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(MAX_SESSION_ID_HYDRATION_IDS),
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
const resourceResolveSchema = z
  .object({
    sessionId: sessionIdField,
    reference: z.string().min(1).max(8_192),
    workspacePath: z.string().min(1).max(8_192).optional(),
  })
  .strict();
const resourceProbeSchema = z.object({
  sessionId: sessionIdField,
  references: z
    .array(z.string().min(1).max(8_192))
    .max(MAX_RESOURCE_PROBE_REFERENCES),
});
const resourceContentSchema = z.object({
  sessionId: sessionIdField,
  download: z.literal("1").optional(),
});
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

export const MAX_JOINING_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const STREAM_EVENT_BATCH_INTERVAL_MS = 16;
const MAX_PROMPT_OPERATION_RECEIPTS = 65_536;
const MAX_PROMPT_OPERATION_RESULTS = 2_048;
const MAX_PROMPT_OPERATION_RESULT_BYTES = 32 * 1024 * 1024;
const PROMPT_OPERATION_RESULT_TTL_MS = 15 * 60 * 1_000;
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 20_000;
const TERMINAL_ATTACH_TICKET_TTL_MS = 15_000;
const MAX_TERMINAL_ATTACH_TICKETS = 2_048;
const MAX_TERMINAL_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_SOCKETS = 128;
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
  /** Shared update-state owner. Production supplies the persistent deployment
   * instance; internal hosts may use the in-memory checker fallback. */
  updateCoordinator?: UpdateCoordinatorLike;
  /** Read-only Pi startup resolution for a canonical prospective workspace. */
  newSessionDefaults?: (cwd: string) => Promise<NewSessionDefaults>;
  distDir?: string;
  /** Complete prior asset generations retained for already-open clients. */
  staticAssetCacheDirs?: readonly string[];
  /** The persistent PTY authority. Production connects to the terminal
   * daemon; tests may supply an in-process implementation. */
  terminal?: TerminalService;
  /** Authenticated local launcher shutdown. System service policy remains
   * outside the HTTP server; this callback only closes this exact Host. */
  shutdown?: () => void | Promise<void>;
  /** Internal cadence override used by the transport liveness test. */
  websocketHeartbeatIntervalMs?: number;
}

function bearerToken(request: Request): string | undefined {
  const value = request.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function accessCookieValues(
  header: string | undefined,
  host: string | undefined,
): { present: boolean; values: string[] } {
  if (!header) return { present: false, values: [] };
  const expectedName = accessCookieName(host);
  let present = false;
  const values: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== expectedName)
      continue;
    present = true;
    try {
      values.push(decodeURIComponent(segment.slice(separator + 1).trim()));
    } catch {
      // A malformed stale value cannot shadow a later valid cookie with the
      // same name. The unauthorized HTTP response expires this origin's copy.
    }
  }
  return { present, values };
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

function clearAccessCookie(request: Request, response: Response): void {
  response.clearCookie(accessCookieName(request.get("host")), {
    httpOnly: true,
    sameSite: "strict",
    secure: request.secure,
    path: "/",
  });
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
    return url.protocol === (secure ? "https:" : "http:") && url.host === host;
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

/** This endpoint deliberately supports one byte range. Express owns RFC
 * parsing (including suffix and open-ended forms); malformed, unsatisfiable,
 * non-byte, and multi-range requests fail rather than unexpectedly receiving
 * the whole potentially large resource. An empty representation ignores Range
 * and returns its complete zero-byte body, as HTTP permits. */
function resourceByteRange(
  request: Request,
  size: number,
): { start: number; end: number } | null {
  if (!request.get("range") || size === 0) return null;
  const ranges = request.range(size);
  if (
    !Array.isArray(ranges) ||
    ranges.type !== "bytes" ||
    ranges.length !== 1
  ) {
    throw requestError("The requested byte range cannot be served", 416, {
      contentRange: `bytes */${size}`,
    });
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
  });
}

export function createInspireServer(deps: AppDependencies): {
  app: express.Express;
  server: Server;
  /** Process-lifetime prompt-delivery authority, also advertised by bootstrap. */
  authorityId: string;
  close: () => Promise<void>;
} {
  const app = express();
  const authorityId = randomUUID();
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
  const updateCoordinator =
    deps.updateCoordinator ??
    new UpdateCoordinator({
      currentPiVersion: deps.piVersion,
      inspireChecker: deps.updateChecker,
      piChecker: deps.piUpdateChecker,
    });
  type PromptOperationResponse = {
    accepted: true;
    historyEntry: Awaited<ReturnType<RuntimeLike["prompt"]>>;
  };
  interface PromptOperationReceipt {
    fingerprint: string;
    promise: Promise<PromptOperationResponse> | null;
    settledAt: number | null;
    resultBytes: number;
  }
  // A process authority must never forget an operation and later accept the
  // same ID again. Settled response bodies retire to small fingerprint
  // tombstones; the bounded process-lifetime map fails closed at its generous
  // limit instead of silently evicting identities.
  const promptOperations = new Map<string, PromptOperationReceipt>();
  const retainedPromptOperationResults: PromptOperationReceipt[] = [];
  let retainedPromptOperationResultBytes = 0;
  const retirePromptOperationResults = (now = Date.now()): void => {
    while (retainedPromptOperationResults.length > 0) {
      const operation = retainedPromptOperationResults[0]!;
      if (
        retainedPromptOperationResults.length <= MAX_PROMPT_OPERATION_RESULTS &&
        retainedPromptOperationResultBytes <=
          MAX_PROMPT_OPERATION_RESULT_BYTES &&
        operation.settledAt !== null &&
        now - operation.settledAt <= PROMPT_OPERATION_RESULT_TTL_MS
      )
        break;
      retainedPromptOperationResults.shift();
      operation.promise = null;
      retainedPromptOperationResultBytes -= operation.resultBytes;
      operation.resultBytes = 0;
    }
  };

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
    if (
      !originAllowed(request.get("origin"), request.get("host"), request.secure)
    ) {
      return response.status(403).json({ error: "Origin is not allowed" });
    }
    const { token } = pairSchema.parse(request.body);
    if (!tokenMatches(token, deps.token))
      return response.status(401).json({ error: "Access token is not valid" });
    setAccessCookie(request, response, deps.token);
    response.status(204).end();
  });

  app.use("/api", (request, response, next) => {
    if (
      !originAllowed(request.get("origin"), request.get("host"), request.secure)
    ) {
      return response.status(403).json({ error: "Origin is not allowed" });
    }
    const bearer = bearerToken(request);
    const cookies = accessCookieValues(
      request.get("cookie"),
      request.get("host"),
    );
    const bearerAuthenticated = tokenMatches(bearer, deps.token);
    const cookieAuthenticated = cookies.values.some((candidate) =>
      tokenMatches(candidate, deps.token),
    );
    if (!bearerAuthenticated && !cookieAuthenticated) {
      if (cookies.present) clearAccessCookie(request, response);
      return response.status(401).json({ error: "Authentication required" });
    }
    // Existing token URLs and non-cookie clients transparently establish the
    // browser pairing on their first authenticated API request.
    if (bearerAuthenticated && !cookieAuthenticated) {
      setAccessCookie(request, response, deps.token);
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ appName: "inspire", mock: deps.mock });
  });

  app.post("/api/host/shutdown", (_request, response) => {
    if (!deps.shutdown)
      return response
        .status(503)
        .json({ error: "Host shutdown is unavailable" });
    response.status(202).end();
    setImmediate(() => {
      Promise.resolve(deps.shutdown?.()).catch((error) => {
        console.error("Authenticated host shutdown failed", error);
      });
    });
  });

  const requireTerminal = (): TerminalService => {
    if (!deps.terminal)
      throw requestError("Terminal service is unavailable", 503, {
        code: "terminal_unavailable",
      });
    return deps.terminal;
  };
  app.get("/api/terminals", async (request, response) => {
    const { cwd } = terminalListSchema.parse(request.query);
    response.json(await requireTerminal().list(cwd));
  });
  app.post("/api/terminals", async (request, response) => {
    response
      .status(201)
      .json(
        await requireTerminal().create(
          terminalCreateSchema.parse(request.body),
        ),
      );
  });
  app.get("/api/terminal-settings", async (_request, response) => {
    response.json(await requireTerminal().getSettings());
  });
  app.patch("/api/terminal-settings", async (request, response) => {
    response.json(
      await requireTerminal().updateSettings(
        terminalSettingsPatchSchema.parse(request.body),
      ),
    );
  });
  app.delete("/api/terminal-history", async (_request, response) => {
    await requireTerminal().clearHistory();
    response.status(204).end();
  });
  app.patch("/api/terminals/:id", async (request, response) => {
    response.json(
      await requireTerminal().rename(
        terminalIdSchema.parse(request.params.id),
        terminalRenameSchema.parse(request.body),
      ),
    );
  });
  app.post("/api/terminals/reorder", async (request, response) => {
    const { cwd, terminalIds } = terminalReorderSchema.parse(request.body);
    response.json(await requireTerminal().reorder(cwd, terminalIds));
  });
  app.post("/api/terminals/:id/restart", async (request, response) => {
    response.json(
      await requireTerminal().restart(
        terminalIdSchema.parse(request.params.id),
      ),
    );
  });
  app.delete("/api/terminals/:id", async (request, response) => {
    const id = terminalIdSchema.parse(request.params.id);
    const force = request.query.force === "1";
    response.json(await requireTerminal().remove(id, force));
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

  app.get("/api/update", async (request, response) => {
    const updateStatus = await updateCoordinator.checkInspire(
      request.query.refresh === "1",
    );
    response.json({
      ...(updateStatus.inspireUpdateCheck ?? { kind: "unavailable" }),
      updateStatus,
    });
  });

  app.get("/api/pi-update", async (request, response) => {
    const updateStatus = await updateCoordinator.checkPi(
      request.query.refresh === "1",
    );
    response.json({
      ...(updateStatus.piUpdateCheck ?? {
        currentVersion: deps.piVersion,
        pi: { kind: "unavailable" },
        extensions: { kind: "unavailable" },
      }),
      updateStatus,
    });
  });

  app.post("/api/update/snooze", async (request, response) => {
    const { identity } = updateSnoozeSchema.parse(request.body);
    response.json(await updateCoordinator.dismiss(identity));
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
    const startedAt = performance.now();
    const [
      preferenceState,
      toolPresentationState,
      availableModels,
      updateStatus,
      snapshot,
    ] = await Promise.all([
      deps.preferences.inspect(),
      deps.toolPresentations
        ? deps.toolPresentations.inspect()
        : Promise.resolve<ToolPresentationConfigurationState>({
            configuration: emptyToolPresentationConfiguration(),
          }),
      deps.availableModels ? deps.availableModels() : Promise.resolve([]),
      updateCoordinator.status(),
      deps.runtime.snapshot(),
    ]);
    const encodedSnapshot = JSON.stringify(snapshot);
    const body: BootstrapResponse = {
      appName: "inspire",
      authorityId,
      snapshotDigest: createHash("sha256")
        .update(encodedSnapshot)
        .digest("hex"),
      version: deps.version,
      piVersion: deps.piVersion,
      mock: deps.mock,
      updateStatus,
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
    response.set(
      "Server-Timing",
      `inspire-bootstrap;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
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
    const root = await resolveProjectDirectory(cwd);
    if (!deps.newSessionDefaults) {
      return response
        .status(503)
        .json({ error: "New-session model resolution is unavailable" });
    }
    response.json({ ...(await deps.newSessionDefaults(root)), cwd: root });
  });
  app.get("/api/new-session/files", async (request, response) => {
    const { cwd, q, limit } = newSessionFileQuerySchema.parse(request.query);
    const root = await resolveProjectDirectory(cwd);
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
    // Lets the browser distinguish a definitive Host refusal from an
    // intermediary 5xx whose delivery outcome remains unknown.
    response.set("X-Inspire-Authority", authorityId);
    const prompt = promptSchema.parse(request.body);
    if (prompt.authorityId !== authorityId)
      throw requestError(
        "The Host restarted before this prompt delivery could be confirmed",
        409,
        { code: "HOST_AUTHORITY_CHANGED" },
      );

    retirePromptOperationResults();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(prompt))
      .digest("hex");
    let operation = promptOperations.get(prompt.operationId);
    if (operation && operation.fingerprint !== fingerprint)
      throw requestError(
        "That prompt operation ID was reused with different content",
        409,
        { code: "PROMPT_OPERATION_MISMATCH" },
      );
    if (operation && !operation.promise)
      throw requestError(
        "This Host already resolved that prompt operation, but its response receipt has retired; inspect the conversation before resending",
        409,
        { code: "PROMPT_OPERATION_RESULT_RETIRED" },
      );
    if (!operation) {
      if (promptOperations.size >= MAX_PROMPT_OPERATION_RECEIPTS)
        throw requestError(
          "This Host has reached its process-lifetime prompt receipt limit",
          503,
          { code: "PROMPT_OPERATION_CAPACITY" },
        );
      const receipt: PromptOperationReceipt = {
        fingerprint,
        promise: null,
        settledAt: null,
        resultBytes: 0,
      };
      const {
        operationId: _operationId,
        authorityId: _authorityId,
        ...request
      } = prompt;
      const promise = deps.runtime.prompt(request).then((historyEntry) => {
        // This runs only for the first successful acceptance of an operation;
        // response retries reuse the same receipt without retriggering checks.
        void updateCoordinator.promptAccepted();
        return { accepted: true as const, historyEntry };
      });
      receipt.promise = promise;
      void promise.then(
        (result) => {
          receipt.settledAt = Date.now();
          receipt.resultBytes = Buffer.byteLength(JSON.stringify(result));
          retainedPromptOperationResultBytes += receipt.resultBytes;
          retainedPromptOperationResults.push(receipt);
          retirePromptOperationResults(receipt.settledAt);
        },
        () => {
          receipt.settledAt = Date.now();
          retainedPromptOperationResults.push(receipt);
          retirePromptOperationResults(receipt.settledAt);
        },
      );
      promptOperations.set(prompt.operationId, receipt);
      operation = receipt;
    }
    response.status(202).json(await operation.promise!);
  });
  app.post("/api/control/native-command", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(
      await deps.runtime.nativeCommand(nativeCommandSchema.parse(request.body)),
    );
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
  app.post("/api/control/auto-compaction", async (request, response) => {
    const { sessionId, enabled } = runtimeBooleanSchema.parse(request.body);
    await deps.runtime.setAutoCompaction(sessionId, enabled);
    response.json({ ok: true });
  });
  app.post("/api/control/auto-retry", async (request, response) => {
    const { sessionId, enabled } = runtimeBooleanSchema.parse(request.body);
    await deps.runtime.setAutoRetry(sessionId, enabled);
    response.json({ ok: true });
  });
  app.post("/api/control/steering-mode", async (request, response) => {
    const { sessionId, mode } = runtimeDeliveryModeSchema.parse(request.body);
    await deps.runtime.setSteeringMode(sessionId, mode);
    response.json({ ok: true });
  });
  app.post("/api/control/follow-up-mode", async (request, response) => {
    const { sessionId, mode } = runtimeDeliveryModeSchema.parse(request.body);
    await deps.runtime.setFollowUpMode(sessionId, mode);
    response.json({ ok: true });
  });
  app.post("/api/extension-ui", async (request, response) => {
    await deps.runtime.extensionUiResponse(extensionSchema.parse(request.body));
    response.json({ ok: true });
  });

  const openSessionCwd = (sessionId: string): string => {
    const cwd = deps.runtime.sessionCwd(sessionId);
    if (!cwd) throw requestError("That session is not open on this host", 409);
    return cwd;
  };

  app.get("/api/files", async (request, response) => {
    const { sessionId, q, limit } = fileQuerySchema.parse(request.query);
    const cwd = openSessionCwd(sessionId);
    response.json({ files: await searchProjectFiles(cwd, q, limit) });
  });
  app.get("/api/files/list", async (request, response) => {
    const { sessionId, dir, refresh } = fileListSchema.parse(request.query);
    const cwd = openSessionCwd(sessionId);
    if (refresh) invalidateProjectIndex(cwd);
    response.json({ entries: await listProjectDirectory(cwd, dir) });
  });
  app.get("/api/git/status", async (request, response) => {
    const { sessionId } = gitStatusSchema.parse(request.query);
    const cwd = openSessionCwd(sessionId);
    response.json(
      await withRequestSignal(request, response, (signal) =>
        deps.git.status(cwd, signal),
      ),
    );
  });
  app.post("/api/git/diff", async (request, response) => {
    const { sessionId, pathId, side } = gitDiffSchema.parse(request.body);
    const cwd = openSessionCwd(sessionId);
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
        throw requestError("No such directory on the host", 404);
      if (code === "EACCES" || code === "EPERM")
        throw requestError("The host cannot read that directory", 403);
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
    const { sessionId, reference, workspacePath } = resourceResolveSchema.parse(
      request.body,
    );
    const context = await deps.runtime.resourceContext(sessionId);
    response.json(
      await deps.resources.resolve(context, reference, true, workspacePath),
    );
  });
  app.get("/api/resources/:id/content", async (request, response) => {
    let closed = response.destroyed;
    response.once("close", () => {
      closed = true;
    });
    const { sessionId, download } = resourceContentSchema.parse(request.query);
    // Handles are bound to the opaque branch view that authorized them. The
    // current authority is rechecked before any headers or bytes are sent.
    const context = await deps.runtime.resourceContext(sessionId);
    const resource = deps.resources.get(
      request.params.id,
      sessionId,
      context.viewId,
    );
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
      const range = resourceByteRange(request, data.length);
      setResourceHeaders(mimeType);
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
      setResourceHeaders();
      response.set("Accept-Ranges", "bytes");
      if (range) {
        response.status(206).set({
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(range.end - range.start + 1),
        });
      } else {
        response.set("Content-Length", String(size));
        if (size === 0) {
          await handle.close();
          response.end();
          return;
        }
      }
      const stream = handle.createReadStream(
        range
          ? { start: range.start, end: range.end }
          : { start: 0, end: size - 1 },
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
    // Content-hashed bundles under /assets are safe to cache forever. Serve
    // the active build first, then bounded prior generations so a connected
    // old page can still perform its first lazy import after a Host rebuild.
    const immutableAssets = {
      immutable: true,
      maxAge: "1y",
      fallthrough: true,
    } as const;
    app.use(
      "/assets",
      express.static(join(distDir, "assets"), immutableAssets),
    );
    for (const cacheDirectory of deps.staticAssetCacheDirs ?? [])
      app.use(
        "/assets",
        express.static(resolve(cacheDirectory), immutableAssets),
      );
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
      response.sendFile(resolve(distDir, "index.html"));
    });
  }

  app.use(apiError);
  const server = createServer(app);
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1_024,
    },
  });
  const terminalWebsocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TERMINAL_INPUT_BYTES + 5,
    perMessageDeflate: false,
  });
  const sockets = new Set<WebSocket>();
  const terminalSockets = new Set<WebSocket>();
  const terminalAttachments = new Map<WebSocket, TerminalAttachment>();
  const responsiveTerminalSockets = new Map<WebSocket, boolean>();
  /** Sockets still waiting for their snapshot; live events queue here so the
   * first frame a client processes is always the authoritative snapshot,
   * with the queued events flushed after it in arrival order. */
  const joining = new Map<WebSocket, { messages: string[]; bytes: number }>();
  const responsiveSockets = new Map<WebSocket, boolean>();
  const requestedSnapshotDigests = new WeakMap<WebSocket, string | null>();
  interface PendingStreamBatch {
    key: string;
    events: unknown[];
    latest: Record<string, unknown>;
    approximateBytes: number;
  }
  let pendingStreamBatch: PendingStreamBatch | null = null;
  let streamBatchTimer: ReturnType<typeof setTimeout> | null = null;
  const forgetSocket = (socket: WebSocket): void => {
    sockets.delete(socket);
    joining.delete(socket);
    responsiveSockets.delete(socket);
  };
  const closeLaggingSocket = (socket: WebSocket, reason: string) => {
    joining.delete(socket);
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.close(1013, reason);
    } catch {
      forgetSocket(socket);
      socket.terminate();
    }
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
    try {
      socket.send(message);
      return true;
    } catch {
      forgetSocket(socket);
      socket.terminate();
      return false;
    }
  };
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
  }, deps.websocketHeartbeatIntervalMs ?? WEBSOCKET_HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  const broadcastEncoded = (
    message: string,
    messageBytes: number,
    destinations: { joining: boolean; established: boolean },
  ): void => {
    for (const socket of sockets) {
      const queue = joining.get(socket);
      if (queue) {
        if (!destinations.joining) continue;
        if (queue.bytes + messageBytes > MAX_JOINING_EVENT_BYTES) {
          closeLaggingSocket(socket, "Snapshot backlog exceeded");
        } else {
          queue.messages.push(message);
          queue.bytes += messageBytes;
        }
      } else if (destinations.established) {
        sendBounded(socket, message);
      }
    }
  };
  const serializeRuntimeEvent = (
    event: unknown,
  ): { message: string; bytes: number } | null => {
    try {
      const message = JSON.stringify(event);
      if (message === undefined) return null;
      return { message, bytes: Buffer.byteLength(message) };
    } catch {
      return null;
    }
  };
  const closeProjectionDestinations = (
    reason: string,
    destinations: { joining: boolean; established: boolean },
  ): void => {
    for (const socket of sockets) {
      const isJoining = joining.has(socket);
      if (
        (isJoining && destinations.joining) ||
        (!isJoining && destinations.established)
      )
        closeLaggingSocket(socket, reason);
    }
  };
  const flushStreamBatch = (): void => {
    if (streamBatchTimer) clearTimeout(streamBatchTimer);
    streamBatchTimer = null;
    const pending = pendingStreamBatch;
    pendingStreamBatch = null;
    if (!pending) return;
    const batch: Record<string, unknown> = { ...pending.latest };
    delete batch.message;
    delete batch.assistantMessageEvent;
    delete batch.streamDelta;
    batch.type = "message_update_batch";
    batch.assistantMessageEvents = pending.events;
    const encoded = serializeRuntimeEvent(batch);
    if (!encoded) {
      closeProjectionDestinations("Runtime event was not serializable", {
        joining: false,
        established: true,
      });
      return;
    }
    if (encoded.bytes > MAX_RUNTIME_EVENT_BYTES) {
      closeProjectionDestinations("Runtime event exceeded projection budget", {
        joining: false,
        established: true,
      });
      return;
    }
    broadcastEncoded(encoded.message, encoded.bytes, {
      joining: false,
      established: true,
    });
  };
  const scheduleStreamBatch = (): void => {
    if (streamBatchTimer) return;
    streamBatchTimer = setTimeout(
      flushStreamBatch,
      STREAM_EVENT_BATCH_INTERVAL_MS,
    );
    streamBatchTimer.unref();
  };
  const publishRuntimeEvent = (event: unknown): void => {
    const record =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : null;
    const streamDelta =
      record?.type === "message_update" &&
      record.streamDelta === true &&
      typeof record.sessionId === "string" &&
      typeof record.streamMessageKey === "string" &&
      record.assistantMessageEvent !== undefined;
    if (!streamDelta || !record) {
      const encoded = serializeRuntimeEvent(event);
      if (!encoded) {
        // A transport projection failure must not throw back through the
        // runtime operation that emitted it. Re-bootstrap every client.
        closeProjectionDestinations("Runtime event was not serializable", {
          joining: true,
          established: true,
        });
        return;
      }
      if (encoded.bytes > MAX_RUNTIME_EVENT_BYTES) {
        // The next bootstrap snapshot is the recovery authority. Never enqueue
        // one exceptional object into every browser socket.
        closeProjectionDestinations(
          "Runtime event exceeded projection budget",
          {
            joining: true,
            established: true,
          },
        );
        return;
      }
      flushStreamBatch();
      broadcastEncoded(encoded.message, encoded.bytes, {
        joining: true,
        established: true,
      });
      return;
    }

    if (sockets.size === 0) return;

    // Joining sockets need complete, overlap-safe replacements. Avoid the
    // cumulative-message stringify entirely when every socket is established;
    // otherwise that hidden O(response length × fragments) cost survives even
    // after wire deltas have removed the redundant network bytes.
    if (joining.size > 0) {
      const complete = serializeRuntimeEvent(event);
      if (!complete) {
        closeProjectionDestinations("Runtime event was not serializable", {
          joining: true,
          established: false,
        });
      } else if (complete.bytes > MAX_RUNTIME_EVENT_BYTES) {
        closeProjectionDestinations(
          "Runtime event exceeded projection budget",
          {
            joining: true,
            established: false,
          },
        );
      } else {
        broadcastEncoded(complete.message, complete.bytes, {
          joining: true,
          established: false,
        });
      }
    }
    const hasEstablishedSocket = [...sockets].some(
      (socket) => !joining.has(socket) && socket.readyState === WebSocket.OPEN,
    );
    if (!hasEstablishedSocket) return;

    const compact = { ...record };
    delete compact.message;
    delete compact.streamDelta;
    const compactEncoded = serializeRuntimeEvent(compact);
    if (!compactEncoded) {
      closeProjectionDestinations("Runtime event was not serializable", {
        joining: false,
        established: true,
      });
      return;
    }
    const key = `${record.sessionId}\0${record.streamMessageKey}`;
    if (
      pendingStreamBatch &&
      (pendingStreamBatch.key !== key ||
        pendingStreamBatch.events.length >= MAX_ASSISTANT_STREAM_BATCH_EVENTS ||
        pendingStreamBatch.approximateBytes + compactEncoded.bytes >
          MAX_RUNTIME_EVENT_BYTES)
    )
      flushStreamBatch();
    if (!pendingStreamBatch) {
      pendingStreamBatch = {
        key,
        events: [],
        latest: compact,
        approximateBytes: 0,
      };
    }
    pendingStreamBatch.events.push(record.assistantMessageEvent);
    pendingStreamBatch.latest = compact;
    pendingStreamBatch.approximateBytes += compactEncoded.bytes;
    scheduleStreamBatch();
  };
  const unsubscribeUpdateStatus = updateCoordinator.subscribe((status) =>
    publishRuntimeEvent({ type: "update_status", updateStatus: status }),
  );
  deps.runtime.on("event", publishRuntimeEvent);

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
    const pairedTokens = accessCookieValues(
      request.headers.cookie,
      request.headers.host,
    ).values;
    const cookieAuthenticated = pairedTokens.some((candidate) =>
      tokenMatches(candidate, deps.token),
    );
    const forwardedHttps = trustedForwardedHttps(request);
    const eventsAuthenticated =
      cookieAuthenticated ||
      (!forwardedHttps && tokenMatches(queryToken, deps.token));
    const originIsAllowed = originAllowed(
      request.headers.origin,
      request.headers.host,
      forwardedHttps,
    );

    if (
      url.pathname === "/terminal" &&
      deps.terminal &&
      cookieAuthenticated &&
      request.headers.origin !== undefined &&
      originIsAllowed
    ) {
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
      return;
    }
    if (url.pathname === "/events" && eventsAuthenticated && originIsAllowed) {
      websocket.handleUpgrade(request, socket, head, (client) => {
        const requestedDigest = url.searchParams.get("snapshot");
        requestedSnapshotDigests.set(
          client,
          requestedDigest && /^[0-9a-f]{64}$/u.test(requestedDigest)
            ? requestedDigest
            : null,
        );
        websocket.emit("connection", client, request);
      });
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

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
        void deps.terminal
          ?.attach({ ...options, terminalId: ticket.terminalId }, sink)
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

  websocket.on("connection", (socket) => {
    // A stream batch belongs only to the sockets that were established when
    // its first delta arrived. Flush before admitting a new snapshot reader.
    flushStreamBatch();
    sockets.add(socket);
    joining.set(socket, { messages: [], bytes: 0 });
    responsiveSockets.set(socket, true);
    socket.on("pong", () => responsiveSockets.set(socket, true));
    socket.on("error", () => {
      forgetSocket(socket);
      socket.terminate();
    });
    socket.on("close", () => forgetSocket(socket));
    void Promise.all([
      deps.runtime.snapshot(),
      updateCoordinator.status(),
    ]).then(
      ([snapshot, updateStatus]) => {
        const queued = joining.get(socket);
        // Pending batches exclude this joining socket, which already queued
        // their complete projections. Flush before it becomes established.
        flushStreamBatch();
        joining.delete(socket);
        if (!queued || socket.readyState !== WebSocket.OPEN) return;
        let message: string;
        try {
          const encodedSnapshot = JSON.stringify(snapshot);
          const snapshotDigest = createHash("sha256")
            .update(encodedSnapshot)
            .digest("hex");
          const unchanged =
            requestedSnapshotDigests.get(socket) === snapshotDigest;
          message = JSON.stringify({
            type: "snapshot",
            authorityId,
            snapshotDigest,
            updateStatus,
            ...(unchanged ? { unchanged: true } : { data: snapshot }),
          });
        } catch {
          socket.close(1011, "Session state was not serializable");
          return;
        }
        if (!sendBounded(socket, message)) return;
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
    authorityId,
    close: async () => {
      clearInterval(heartbeatInterval);
      if (streamBatchTimer) clearTimeout(streamBatchTimer);
      streamBatchTimer = null;
      pendingStreamBatch = null;
      terminalTickets.clear();
      deps.runtime.off("event", publishRuntimeEvent);
      unsubscribeUpdateStatus();
      // Stop accepting HTTP/upgrades first, but do not await the drain before
      // runtime teardown: an active request may itself be waiting on runtime.
      const drained = server.listening
        ? new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
          })
        : Promise.resolve();
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      for (const socket of terminalSockets)
        socket.close(1001, "Server shutting down");
      const runtimeResult = await deps.runtime.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      server.closeIdleConnections();
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      server.closeAllConnections();
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
      const resourceResult = await deps.resources.close().then(
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
        resourceResult,
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
