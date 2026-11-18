import { z } from "zod";
import {
  type ActiveSnapshot,
  type BootstrapResponse,
  type BranchForkResponse,
  type BranchNavigateResponse,
  type GitDiffResponse,
  type GitStatusResponse,
  type HostDirListing,
  type HostNativeCommandResponse,
  type HostRootsResponse,
  type HostUpdateStatus,
  type InspirePreferences,
  MAX_CURATED_SESSION_RESULTS,
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  type ModelSelectionResponse,
  type PendingCopyContent,
  type PreferencePublication,
  type ProjectDirEntry,
  type ResourceDescriptor,
  type ResourceProbeResponse,
  SESSION_HISTORY_PATH,
  type SessionDeletionResponse,
  type SessionExportResponse,
  type SessionHistoryPages,
  type SessionListResponse,
  THINKING_LEVELS,
} from "./contracts.js";
import type { HerdrEnhancementStatus } from "./herdr.js";
import { historyQuerySchema } from "./history-query.js";
import { hostOperationIdentitySchema } from "./host-operations.js";
import {
  HOST_RESTART_PATH,
  type HostRestartStatus,
  hostRestartRequestSchema,
  type restartObservation,
} from "./host-restart.js";
import {
  HTML_PREVIEW_BYTES,
  type HtmlPreviewResponse,
} from "./html-preview.js";
import { endpoint } from "./json-endpoints.js";
import {
  type McpConfigSnapshot,
  type McpConfigWriteResult,
  type McpConnectionValues,
  mcpConfigEditSchema,
  mcpConnectionReadSchema,
} from "./mcp.js";
import {
  type ModelCatalogResponse,
  type ModelSettingsSnapshot,
  type ModelSettingsWriteResult,
  modelConfigEditSchema,
  modelPreferencesPatchSchema,
} from "./model-settings.js";
import {
  pushSubscriptionSchema,
  type TaskAlertSettings,
} from "./notifications.js";
import { preferencesPatchSchema } from "./preferences-schema.js";
import type { ProviderAuthResult } from "./provider-auth-bridge.js";
import {
  MAX_RESOURCE_PROBE_REFERENCES,
  MAX_RESOURCE_REFERENCE_LENGTH,
  type SessionResourceListResponse,
} from "./resource-references.js";
import type {
  TerminalAttachTicketResponse,
  TerminalCatalogResponse,
  TerminalServiceSettings,
} from "./terminal-contracts.js";
import { terminalIdSchema } from "./terminal-operations.js";
import type {
  PresentationAdapterInfo,
  ToolPresentationConfiguration,
} from "./tool-presentation-config.js";

export interface ProjectFileSearchResult {
  files: ProjectFileResult[];
  truncated?: boolean;
}

export interface ProjectFileResult {
  path: string;
  name: string;
  /** Canonical project root on pre-session results. */
  workspaceCwd?: string;
}

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
const sessionDeletionSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("session"),
    sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  }),
  z.strictObject({
    scope: z.literal("hidden"),
    sessionIds: z
      .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
      .min(1)
      .max(MAX_CURATED_SESSION_RESULTS),
    projectCwd: z.string().min(1).max(4_096).optional(),
  }),
]);
const newSchema = z
  .object({
    cwd: z.string().min(1).max(4_096),
    receipt: hostOperationIdentitySchema.optional(),
    createDirectory: z.boolean().optional(),
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
export const sessionIdField = z.string().min(1).max(MAX_SESSION_ID_CHARS);
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
const runtimeSetting = z.discriminatedUnion("key", [
  z.strictObject({
    key: z.enum(["autoCompactionEnabled", "autoRetryEnabled"]),
    value: z.boolean(),
  }),
  z.strictObject({
    key: z.enum(["steeringMode", "followUpMode"]),
    value: z.enum(["all", "one-at-a-time"]),
  }),
]);
export type RuntimeSetting = z.input<typeof runtimeSetting>;
const clearPendingSchema = z.object({ sessionId: sessionIdField }).strict();
const pendingReadSchema = z
  .object({
    sessionId: sessionIdField,
    viewId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative(),
    itemId: z.string().min(1).max(128).optional(),
  })
  .strict();
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
const showHiddenField = z
  .enum(["0", "1"])
  .default("0")
  .transform((value) => value === "1");
const fileQuerySchema = z.object({
  showHidden: showHiddenField,
  sessionId: sessionIdField,
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const newSessionFileQuerySchema = fileQuerySchema
  .omit({ sessionId: true })
  .extend({ cwd: z.string().min(1).max(4_096) });
const fileListSchema = z.object({
  showHidden: showHiddenField,
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
  showHidden: showHiddenField,
  path: z.string().min(1).max(4_096).optional(),
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
const sessionAddress = z.object({ sessionId: sessionIdField });
const resourceResolveSchema = z
  .object({
    sessionId: sessionIdField,
    reference: z.string().min(1).max(MAX_RESOURCE_REFERENCE_LENGTH),
    workspacePath: z.string().min(1).max(8_192).optional(),
  })
  .strict();
const resourceProbeSchema = z.object({
  sessionId: sessionIdField,
  references: z
    .array(z.string().min(1).max(MAX_RESOURCE_REFERENCE_LENGTH))
    .max(MAX_RESOURCE_PROBE_REFERENCES),
});
const assistantTextSchema = z
  .object({
    sessionId: sessionIdField,
    viewId: z.string().min(1).max(512),
  })
  .strict();
const branchTarget = {
  sessionId: sessionIdField,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  targetId: z.string().min(1).max(200),
};
const branchNavigateSchema = z.union([
  z.strictObject({ ...branchTarget, mode: z.literal("watch") }),
  z
    .object({
      ...branchTarget,
      mode: z.enum(["switch", "edit"]),
      summarize: z.boolean().optional(),
      customInstructions: z.string().max(2000).optional(),
    })
    .strict(),
]);
const branchForkSchema = z
  .object({
    sessionId: sessionIdField,
    viewId: z.string().min(1).max(200),
    targetId: z.string().min(1).max(200),
  })
  .strict();
const branchCloneSchema = branchForkSchema.extend({
  targetId: z.string().min(1).max(200).nullable(),
});
const gitDiffSchema = z.object({
  sessionId: sessionIdField,
  pathId: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const owner = z.object({
  sessionId: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
});
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const providerToken = z.string().min(1).max(256);
const authOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("providers") }),
  z.object({
    operation: z.literal("start"),
    provider: providerToken,
    type: z.enum(["api_key", "oauth"]),
  }),
  z.object({ operation: z.literal("status"), id: providerToken }),
  z.object({
    operation: z.literal("answer"),
    id: providerToken,
    promptId: providerToken,
    value: z.string().max(32_768),
  }),
  z.object({ operation: z.literal("cancel"), id: providerToken }),
  z.object({ operation: z.literal("logout"), provider: providerToken }),
]);
const ok = endpoint<{ ok: boolean }>();
const snapshot = endpoint<ActiveSnapshot>();
const modelSelection = endpoint<ModelSelectionResponse>();
const sessionRows = endpoint<{ sessions: SessionListResponse["sessions"] }>();
const longObservation = { timeoutMs: 120_000 };
const waitForCompletion = { timeoutMs: null };
const read = { mutation: false };

const taskSettings = endpoint<TaskAlertSettings>();
const quick = { timeoutMs: 10_000 };
const taskUpdate = z
  .strictObject({
    mode: z.enum(["off", "title", "desktop"]).optional(),
    grouping: z.enum(["session", "project"]).optional(),
    subscription: pushSubscriptionSchema.nullable().optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Provide a mode, subscription or grouping update",
  );

export const hostEndpoints = {
  taskAlertSettings: taskSettings("get", "/api/notifications", {}, quick),
  configureTaskAlerts: taskSettings(
    "put",
    "/api/notifications",
    { body: taskUpdate },
    quick,
  ),
  acknowledgeTaskAlert: ok(
    "post",
    "/api/notifications/ack",
    { body: z.strictObject({ id: providerToken }) },
    quick,
  ),
  testTaskAlert: endpoint<{ transport: "push" | "page" }>()(
    "post",
    "/api/notifications/test",
    {},
    { timeoutMs: 15_000 },
  ),
  restartHost: endpoint<ReturnType<typeof restartObservation>>()(
    "post",
    HOST_RESTART_PATH,
    { body: hostRestartRequestSchema },
    quick,
  ),
  herdrStatus: endpoint<HerdrEnhancementStatus>()(
    "get",
    "/api/host/herdr",
    {},
    { timeoutMs: 10_000 },
  ),
  hostRestartStatus: endpoint<HostRestartStatus>()(
    "get",
    HOST_RESTART_PATH,
    {},
    { timeoutMs: 10_000 },
  ),
  bootstrap: endpoint<BootstrapResponse>()("get", "/api/bootstrap"),
  checkUpdates: endpoint<HostUpdateStatus>()("get", "/api/update", {
    query: z.object({
      kind: z.enum(["inspire", "pi"]),
      refresh: z.literal("1").optional(),
    }),
  }),
  snoozeUpdate: endpoint<HostUpdateStatus>()("post", "/api/update/snooze", {
    body: updateSnoozeSchema,
  }),
  snapshot: snapshot("get", "/api/snapshot", {
    query: z.object({ detail: sessionIdField.or(z.literal("")) }),
  }),
  sessionHistory: endpoint<SessionHistoryPages[keyof SessionHistoryPages]>()(
    "get",
    SESSION_HISTORY_PATH,
    { query: historyQuerySchema },
  ),
  lastAssistantText: endpoint<{ text: string | null }>()(
    "get",
    "/api/transcript/assistant-text",
    { query: assistantTextSchema },
  ),
  cloneBranch: endpoint<BranchForkResponse>()(
    "post",
    "/api/branches/clone",
    { body: branchCloneSchema },
    longObservation,
  ),
  navigateBranch: endpoint<BranchNavigateResponse>()(
    "post",
    "/api/branches/navigate",
    { body: branchNavigateSchema },
    waitForCompletion,
  ),
  forkBranch: endpoint<BranchForkResponse>()(
    "post",
    "/api/branches/fork",
    { body: branchForkSchema },
    longObservation,
  ),
  sessions: endpoint<SessionListResponse>()("get", "/api/sessions", {
    query: sessionQuerySchema,
  }),
  refreshSessions: ok("post", "/api/sessions/refresh"),
  sessionsByIds: sessionRows(
    "post",
    "/api/sessions/by-id",
    { body: sessionIdsSchema },
    read,
  ),
  sessionsByCwds: sessionRows(
    "post",
    "/api/sessions/by-cwd",
    { body: sessionCwdsSchema },
    read,
  ),
  openSession: snapshot("post", "/api/sessions/open", { body: openSchema }),
  takeOverSession: snapshot("post", "/api/sessions/takeover", {
    body: sessionAddress,
  }),
  resumeCommand: endpoint<{
    command: string;
    projectDirectoryMissing?: boolean;
  }>()("get", "/api/sessions/resume-command", { query: sessionAddress }),
  deselectSession: snapshot("post", "/api/sessions/deselect"),
  newSession: snapshot(
    "post",
    "/api/sessions/new",
    { body: newSchema },
    longObservation,
  ),
  refreshModels: endpoint<ModelCatalogResponse>()("get", "/api/models", {
    query: owner.extend({
      sessionId: sessionIdField.optional(),
      inherit: z.literal("1").optional(),
    }),
  }),
  mcpConfig: endpoint<McpConfigSnapshot>()("get", "/api/mcp-config", {
    query: owner.strict(),
  }),
  mcpConnection: endpoint<McpConnectionValues>()(
    "post",
    "/api/mcp-config/connection",
    { query: owner.strict(), body: mcpConnectionReadSchema },
    { invalidInput: "Invalid MCP connection read" },
  ),
  editMcpConfig: endpoint<McpConfigWriteResult>()(
    "patch",
    "/api/mcp-config",
    { query: owner.strict(), body: mcpConfigEditSchema },
    { invalidInput: "Invalid MCP configuration edit" },
  ),
  modelSettings: endpoint<ModelSettingsSnapshot>()(
    "get",
    "/api/model-settings",
    { query: owner.extend({ refresh: z.literal("1").optional() }) },
  ),
  saveModelPreferences: endpoint<ModelSettingsWriteResult>()(
    "patch",
    "/api/model-settings",
    {
      query: owner,
      body: z.strictObject({ revision, patch: modelPreferencesPatchSchema }),
    },
  ),
  editModelConfig: endpoint<ModelSettingsWriteResult>()(
    "patch",
    "/api/model-settings/config",
    {
      query: owner,
      body: z.strictObject({ revision, edit: modelConfigEditSchema }),
    },
  ),
  providerAuth: endpoint<{ result: ProviderAuthResult }>()(
    "post",
    "/api/provider-auth",
    { query: owner, body: authOperation },
  ),
  searchNewSessionFiles: endpoint<ProjectFileSearchResult & { cwd: string }>()(
    "get",
    "/api/new-session/files",
    { query: newSessionFileQuerySchema },
  ),
  renameSession: ok("post", "/api/sessions/rename", { body: renameSchema }),
  deleteSessions: endpoint<SessionDeletionResponse>()(
    "post",
    "/api/sessions/delete",
    { body: sessionDeletionSchema },
  ),
  terminals: endpoint<TerminalCatalogResponse>()("get", "/api/terminals", {
    query: owner.pick({ cwd: true }),
  }),
  terminalAttachTicket: endpoint<TerminalAttachTicketResponse>()(
    "post",
    "/api/terminals/:id/attach-ticket",
    { params: z.object({ id: terminalIdSchema }) },
  ),
  terminalSettings: endpoint<TerminalServiceSettings>()(
    "get",
    "/api/terminal-settings",
  ),
  nativeCommand: endpoint<HostNativeCommandResponse>()(
    "post",
    "/api/control/native-command",
    { body: nativeCommandSchema },
    waitForCompletion,
  ),
  piChangelog: endpoint<{ version: string; markdown: string }>()(
    "get",
    "/api/pi/changelog",
  ),
  exportSession: endpoint<SessionExportResponse>()(
    "post",
    "/api/sessions/export",
    { body: sessionAddress.extend({ format: z.enum(["html", "jsonl"]) }) },
    waitForCompletion,
  ),
  pendingText: endpoint<PendingCopyContent>()(
    "post",
    "/api/pending/text",
    { body: pendingReadSchema },
    read,
  ),
  clearPending: ok("post", "/api/pending/clear", { body: clearPendingSchema }),
  cycleModel: endpoint<unknown>()("post", "/api/control/model-cycle", {
    body: z.strictObject({
      sessionId: z.string().min(1),
      direction: z.union([z.literal(1), z.literal(-1)]),
    }),
  }),
  setModel: modelSelection("post", "/api/control/model", { body: modelSchema }),
  setThinkingLevel: modelSelection("post", "/api/control/thinking", {
    body: thinkingSchema,
  }),
  setRuntimeSetting: ok("post", "/api/control/runtime-setting", {
    body: z.strictObject({
      sessionId: sessionIdField,
      setting: runtimeSetting,
    }),
  }),
  searchFiles: endpoint<ProjectFileSearchResult>()("get", "/api/files", {
    query: fileQuerySchema,
  }),
  listFiles: endpoint<{ entries: ProjectDirEntry[]; truncated?: boolean }>()(
    "get",
    "/api/files/list",
    { query: fileListSchema },
  ),
  gitStatus: endpoint<GitStatusResponse>()("get", "/api/git/status", {
    query: sessionAddress,
  }),
  gitDiff: endpoint<GitDiffResponse>()(
    "post",
    "/api/git/diff",
    { body: gitDiffSchema },
    read,
  ),
  browseHostRoots: endpoint<HostRootsResponse>()("get", "/api/host/roots"),
  browseHostDirs: endpoint<HostDirListing>()("get", "/api/host/dirs", {
    query: hostDirsSchema,
  }),
  listResources: endpoint<SessionResourceListResponse>()(
    "post",
    "/api/resources/list",
    { body: sessionAddress },
    read,
  ),
  probeResources: endpoint<ResourceProbeResponse>()(
    "post",
    "/api/resources/probe",
    { body: resourceProbeSchema },
    read,
  ),
  resolveResource: endpoint<ResourceDescriptor>()(
    "post",
    "/api/resources/resolve",
    { body: resourceResolveSchema },
    read,
  ),
  deleteAttachment: ok("delete", "/api/attachments/:id", {
    params: z.object({ id: z.string().uuid() }),
  }),
  createHtmlPreview: endpoint<HtmlPreviewResponse>()(
    "post",
    "/api/resources/:id/interactive",
    {
      params: z.object({ id: z.string() }),
      body: z.strictObject({
        sessionId: z.string().min(1),
        html: z.string().max(HTML_PREVIEW_BYTES),
      }),
    },
  ),
  deleteHtmlPreview: endpoint<void>()("delete", "/api/html-previews/:id", {
    params: z.object({ id: z.string() }),
    query: z.strictObject({ sessionId: z.string().min(1) }),
  }),
  resourceDownloadTicket: endpoint<{ ticket: string; expiresAt: number }>()(
    "post",
    "/api/resources/:id/download-ticket",
    {
      params: z.object({ id: z.string() }),
      body: sessionAddress.strict(),
    },
    read,
  ),
  showInFileManager: ok("post", "/api/resources/show-in-file-manager", {
    body: resourceResolveSchema.extend({
      directory: z.boolean().default(false),
    }),
  }),
  respondExtensionUi: ok("post", "/api/extension-ui", {
    body: extensionSchema,
  }),
  setPresentationAdapterEnabled: endpoint<{
    configuration: ToolPresentationConfiguration;
    adapters?: PresentationAdapterInfo[];
    warning?: string;
    preferences: InspirePreferences;
    preferenceRevision: number;
  }>()("patch", "/api/presentation-adapters/:id", {
    params: z.object({ id: z.string() }),
    body: z.strictObject({ enabled: z.boolean() }),
  }),
  preferences: endpoint<PreferencePublication>()("get", "/api/preferences"),
  savePreferences: endpoint<PreferencePublication>()(
    "patch",
    "/api/preferences",
    {
      body: preferencesPatchSchema,
    },
  ),
} as const;
