import type {
  ActiveSnapshot,
  BootstrapResponse,
  BranchCloneRequest,
  BranchEntryRequest,
  BranchEntryResponse,
  BranchForkRequest,
  BranchForkResponse,
  BranchLeavesResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeQuery,
  BranchTreeResponse,
  ComposerHistoryPage,
  GitDiffResponse,
  GitStatusResponse,
  HiddenClearResponse,
  HostDirListing,
  HostNativeCommandRequest,
  HostNativeCommandResponse,
  HostRootsResponse,
  HostUpdateStatus,
  InspirePreferences,
  InspireUpdateCheckResult,
  ModelSelectionResponse,
  NewSessionOptions,
  PendingCopyContent,
  PendingOperationIdentity,
  PendingOperationRequest,
  PendingReadRequest,
  PendingRecovery,
  PiMessageDeliveryMode,
  PiUpdateCheckResult,
  ProjectDirEntry,
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  PromptDeliveryResponse,
  ResourceDescriptor,
  ResourceProbeResponse,
  SessionDeleteResponse,
  SessionExportRequest,
  SessionExportResponse,
  SessionListResponse,
  SessionOpenResponse,
  ThinkingLevel,
  TranscriptActivityPage,
  TranscriptPage,
  UploadedAttachment,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts";
import type { HerdrEnhancementStatus } from "../shared/herdr";
import type {
  HostRestartOperation,
  HostRestartRequest,
  HostRestartStatus,
} from "../shared/host-restart";
import type { HtmlPreviewResponse } from "../shared/html-preview";
import type {
  McpConfigEdit,
  McpConfigSnapshot,
  McpConfigWriteResult,
  McpConnectionRead,
  McpConnectionValues,
} from "../shared/mcp";
import type {
  ModelCatalogResponse,
  ModelConfigEdit,
  ModelPreferencesPatch,
  ModelSettingsSnapshot,
  ModelSettingsWriteResult,
} from "../shared/model-settings";
import type {
  ProviderAuthOperation,
  ProviderAuthResult,
} from "../shared/provider-auth-bridge";
import type { SessionResourceListResponse } from "../shared/resource-references";
import type {
  TerminalAttachTicketResponse,
  TerminalCatalogResponse,
  TerminalCreateRequest,
  TerminalDescriptor,
  TerminalRemoveResponse,
  TerminalRenameRequest,
  TerminalReorderRequest,
  TerminalServiceSettings,
  TerminalServiceSettingsPatch,
} from "../shared/terminal-contracts";
import type {
  PresentationAdapterInfo,
  ToolPresentationConfiguration,
} from "../shared/tool-presentation-config";
import { terminalOperations } from "./controllers/terminal-operation-controller";
import { withTransportMeasure } from "./transport-performance";

export interface ProjectFileSearchResult {
  files: ProjectFileResult[];
  truncated?: boolean;
}

export interface ProjectFileResult {
  path: string;
  name: string;
  /** Canonical workspace identity for pre-session results. Session-bound
   * results omit it because their runtime slot already owns the root. */
  workspaceCwd?: string;
}

import { authenticatedFetch, BrowserPairingError } from "./browser-auth";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Candidate paths a refusal offered instead of guessing between them. */
    public matches?: string[],
    public code?: string,
    /** Public edge that produced the HTTP status, when explicitly marked. */
    public edge?: string,
    /** Host process that authored this application response, when present. */
    public authorityId?: string,
    /** The Host can authoritatively report that the operation outcome is unknown. */
    public outcomeUnknown = false,
    /** A refusal of this operation, not just failure to observe its receipt. */
    public promptReceipt?: { operationId: string; outcome: string },
    /** A settled Pending handoff, including failure or result retirement. */
    public pendingReceipt?: { operationId: string; outcome: string },
    public recoveredAttachments?: UploadedAttachment[],
    public recoveryId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const PROMPT_CONFIRMATION_TIMEOUT_MS = 30_000;
// Leave room for the Host's 30-second Pi reads and response transfer.
export const HTTP_OBSERVATION_TIMEOUT_MS = 45_000;
const LONG_HTTP_OBSERVATION_TIMEOUT_MS = 120_000;

/** No trustworthy application response. A mutation may still complete; an
 * observation failure is never permission to replay it. */
export class ApiTransportError extends Error {
  constructor(
    public phase: "request" | "response",
    public outcomeUnknown = false,
    public timedOut = false,
  ) {
    super(
      outcomeUnknown
        ? "INSΠRE could not confirm the result. This action may still complete. Check before trying again."
        : timedOut
          ? "The request timed out. Try again."
          : phase === "request"
            ? "The INSΠRE address did not return a response"
            : "The INSΠRE address returned an invalid response",
    );
    this.name = "ApiTransportError";
  }
}

function aborted(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AbortError",
  );
}

async function applicationFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await authenticatedFetch(input, init);
  } catch (error) {
    if (aborted(error)) throw error;
    if (error instanceof BrowserPairingError)
      throw new ApiError(401, error.message);
    throw new ApiTransportError("request");
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (aborted(error)) throw error;
    throw new ApiTransportError("response");
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `Request failed (${response.status})`;
  let matches: string[] | undefined;
  let code: string | undefined;
  let outcomeUnknown = false;
  let recoveredAttachments: UploadedAttachment[] | undefined;
  let recoveryId: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: string;
      matches?: unknown;
      code?: unknown;
      outcomeUnknown?: unknown;
      recoveredAttachments?: UploadedAttachment[];
      recoveryId?: unknown;
    };
    if (body.error) message = body.error;
    if (Array.isArray(body.matches)) matches = body.matches.map(String);
    if (typeof body.code === "string") code = body.code;
    outcomeUnknown = body.outcomeUnknown === true;
    if (
      body.code === "PROMPT_RECOVERED" &&
      Array.isArray(body.recoveredAttachments)
    )
      recoveredAttachments = body.recoveredAttachments;
    if (body.code === "PROMPT_RECOVERED" && typeof body.recoveryId === "string")
      recoveryId = body.recoveryId;
  } catch (error) {
    if (aborted(error)) throw error;
    // A non-JSON HTTP error still has a useful status. Losing the body in
    // transit, however, is not an authoritative application refusal.
    if (!(error instanceof SyntaxError))
      throw new ApiTransportError("response");
  }
  throw new ApiError(
    response.status,
    message,
    matches,
    code,
    response.headers.get("X-Inspire-Edge") ?? undefined,
    response.headers.get("X-Inspire-Authority") ?? undefined,
    outcomeUnknown,
    response.headers.has("X-Inspire-Prompt-Operation")
      ? {
          operationId: response.headers.get("X-Inspire-Prompt-Operation")!,
          outcome: response.headers.get("X-Inspire-Prompt-Outcome") ?? "",
        }
      : undefined,
    response.headers.has("X-Inspire-Pending-Operation")
      ? {
          operationId: response.headers.get("X-Inspire-Pending-Operation")!,
          outcome: response.headers.get("X-Inspire-Pending-Outcome") ?? "",
        }
      : undefined,
    recoveredAttachments,
    recoveryId,
  );
}

/** Cancellation retires an observer, not a Host operation. Keep it distinct
 * from a failed transport, even when the abandoned write may have committed. */
export class ApiRequestCancelledError extends Error {
  constructor(public outcomeUnknown: boolean) {
    super("Request observation cancelled");
    this.name = "AbortError";
  }
}

interface ObservationOptions {
  /** null keeps Pi-owned long operations completion-driven. */
  timeoutMs?: number | null;
  mutation?: boolean;
}

async function observeRequest<T>(
  signal: AbortSignal | null | undefined,
  {
    timeoutMs = HTTP_OBSERVATION_TIMEOUT_MS,
    mutation = false,
  }: ObservationOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // A pre-cancelled request has never been dispatched.
  if (signal?.aborted) throw new ApiRequestCancelledError(false);
  const controller = new AbortController();
  let cancel!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      reject(
        signal?.reason?.name === "TimeoutError"
          ? new ApiTransportError("request", mutation, true)
          : new ApiRequestCancelledError(mutation),
      );
      controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (timeoutMs !== null)
      timer = setTimeout(() => {
        reject(new ApiTransportError("request", mutation, true));
        controller.abort();
      }, timeoutMs);
  });
  try {
    // Bound body consumption too, and settle even if a transport ignores abort.
    return await Promise.race([run(controller.signal), interrupted]);
  } catch (error) {
    // Fetch/body aborts without an owner cancellation are transport loss too.
    if (aborted(error) && !(error instanceof ApiRequestCancelledError))
      throw new ApiTransportError("request", mutation);
    if (error instanceof ApiTransportError && mutation && !error.outcomeUnknown)
      throw new ApiTransportError(error.phase, true, error.timedOut);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: ObservationOptions = {},
): Promise<T> {
  return observeRequest(
    init.signal,
    { mutation: Boolean(init.method && init.method !== "GET"), ...options },
    async (signal) => {
      const response = await applicationFetch(path, {
        ...init,
        signal,
        headers: {
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...init.headers,
        },
      });
      await ensureOk(response);
      return responseJson<T>(response);
    },
  );
}

interface ResourceContentOptions {
  byteLimit?: number;
  signal?: AbortSignal;
}

interface ResourceContentResponse {
  blob: Blob;
  /** Current total bytes reported by this transfer, not resolve metadata. */
  totalSize: number;
}

function contentTotalSize(response: Response, blob: Blob): number {
  const contentRange = response.headers.get("Content-Range");
  if (!contentRange) return blob.size;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  const total = match ? Number(match[3]) : Number.NaN;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== 0 ||
    end < start ||
    end - start + 1 !== blob.size ||
    total <= end
  ) {
    throw new ApiError(502, "The resource response has an invalid byte range");
  }
  return total;
}

/** Two minutes of overhead plus transfer time at 128 KiB/s. */
function transferObservationTimeout(bytes: number): number {
  return LONG_HTTP_OBSERVATION_TIMEOUT_MS + Math.ceil(bytes / 131_072) * 1_000;
}

async function fetchResourceContent(
  id: string,
  sessionId: string,
  options: ResourceContentOptions = {},
): Promise<ResourceContentResponse> {
  return observeRequest(
    options.signal,
    { timeoutMs: transferObservationTimeout(options.byteLimit ?? 0) },
    async (signal) => {
      const response = await applicationFetch(
        `/api/resources/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`,
        {
          signal,
          headers: {
            ...(options.byteLimit
              ? { Range: `bytes=0-${Math.max(0, options.byteLimit - 1)}` }
              : {}),
          },
        },
      );
      await ensureOk(response);
      let blob: Blob;
      try {
        blob = await response.blob();
      } catch (error) {
        if (aborted(error)) throw error;
        throw new ApiTransportError("response");
      }
      if (options.byteLimit !== undefined && blob.size > options.byteLimit) {
        throw new ApiError(
          502,
          "The resource response exceeded its byte limit",
        );
      }
      return { blob, totalSize: contentTotalSize(response, blob) };
    },
  );
}

async function uploadFiles(
  files: File[],
  signal?: AbortSignal,
): Promise<{ attachments: UploadedAttachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const bytes = files.reduce((total, file) => total + file.size, 0);
  return observeRequest(
    signal,
    { mutation: true, timeoutMs: transferObservationTimeout(bytes) },
    async (signal) => {
      // No Content-Type header: the browser sets the multipart boundary.
      const response = await applicationFetch("/api/attachments", {
        method: "POST",
        signal,
        body: form,
      });
      await ensureOk(response);
      const result = await responseJson<{ attachments: UploadedAttachment[] }>(
        response,
      );
      // A transport may ignore abort and finish after its observer is gone.
      // Those staged handles must not be returned to a composer or leak bytes.
      if (signal.aborted)
        await Promise.all(
          result.attachments.map((item) =>
            request(`/api/attachments/${encodeURIComponent(item.id)}`, {
              method: "DELETE",
            }).catch(() => undefined),
          ),
        );
      return result;
    },
  );
}

function post<T>(
  path: string,
  body?: unknown,
  init: RequestInit = {},
  options: ObservationOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      ...init,
      method: "POST",
      body: JSON.stringify(body ?? {}),
    },
    options,
  );
}

function waitForPromptPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      if (signal?.aborted) reject(new ApiRequestCancelledError(true));
      else resolve();
    };
    const timer = window.setTimeout(finish, 250);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

async function deliverPrompt(
  body: PromptDeliveryRequest,
  signal?: AbortSignal,
): Promise<PromptAcceptedResponse> {
  const init = { signal };
  // Losing even a read-only observation leaves the submitted write uncertain.
  const observation = {
    timeoutMs: PROMPT_CONFIRMATION_TIMEOUT_MS,
    mutation: true,
  };
  const receiptPath = `/api/prompt/${encodeURIComponent(body.operationId)}?authorityId=${encodeURIComponent(body.authorityId)}`;
  let first = true;
  for (;;) {
    let response: PromptDeliveryResponse;
    try {
      response = await (first
        ? post<PromptDeliveryResponse>("/api/prompt", body, init, observation)
        : request<PromptDeliveryResponse>(receiptPath, init, observation));
    } catch (error) {
      // Even an authenticated 401/404/500 can refuse the observation without
      // saying anything about an earlier dispatch. Only the retained operation
      // receipt may declare that same operation rejected.
      if (
        error instanceof ApiError &&
        !(
          error.edge !== "ssh-reverse" &&
          error.authorityId === body.authorityId &&
          error.promptReceipt?.operationId === body.operationId &&
          error.promptReceipt.outcome === "rejected"
        )
      )
        error.outcomeUnknown = true;
      throw error;
    }
    if (response?.accepted === true) return response;
    if (
      !response ||
      response.pending !== true ||
      response.operationId !== body.operationId ||
      response.authorityId !== body.authorityId
    )
      throw new ApiTransportError("response", true);
    // Poll the receipt, not another delivery of potentially large attachments.
    // Pi may still be compacting, running an input hook, or awaiting a dialog.
    first = false;
    await waitForPromptPoll(signal);
  }
}

function settingsQuery(owner: { sessionId?: string; cwd?: string }): string {
  return new URLSearchParams({
    ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : {}),
    ...(owner.cwd !== undefined ? { cwd: owner.cwd } : {}),
  }).toString();
}

export function createApi() {
  return {
    taskAlertSettings: () =>
      request<import("../shared/notifications").TaskAlertSettings>(
        "/api/notifications",
        { signal: AbortSignal.timeout(10_000) },
      ),
    configureTaskAlerts: (
      mode:
        | import("../shared/contracts").CompletionAttentionPreference
        | undefined,
      subscription?: PushSubscriptionJSON | null,
      grouping?: import("../shared/notifications").TaskNotificationGrouping,
    ) =>
      request<import("../shared/notifications").TaskAlertSettings>(
        "/api/notifications",
        {
          method: "PUT",
          body: JSON.stringify({
            mode,
            grouping,
            subscription: subscription
              ? { endpoint: subscription.endpoint, keys: subscription.keys }
              : subscription,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      ),
    acknowledgeTaskAlert: (id: string) =>
      request<{ ok: true }>("/api/notifications/ack", {
        method: "POST",
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(10_000),
      }),
    testTaskAlert: () =>
      request<{ transport: "push" | "page" }>("/api/notifications/test", {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      }),
    herdrStatus: () =>
      request<HerdrEnhancementStatus>("/api/host/herdr", {
        signal: AbortSignal.timeout(10_000),
      }),
    hostRestartStatus: () =>
      request<HostRestartStatus>("/api/host/restart", {
        signal: AbortSignal.timeout(10_000),
      }),
    restartHost: (intent: HostRestartRequest) =>
      request<HostRestartOperation>("/api/host/restart", {
        method: "POST",
        body: JSON.stringify(intent),
        signal: AbortSignal.timeout(10_000),
      }),
    bootstrap: (signal?: AbortSignal, sessionId?: string | null) =>
      withTransportMeasure("bootstrap-confirmation", () =>
        request<BootstrapResponse>(`/api/bootstrap${detailQuery(sessionId)}`, {
          signal,
        }),
      ),
    update: (refresh = false) =>
      request<InspireUpdateCheckResult>(
        `/api/update${refresh ? "?refresh=1" : ""}`,
      ),
    piUpdate: (refresh = false) =>
      request<PiUpdateCheckResult>(
        `/api/pi-update${refresh ? "?refresh=1" : ""}`,
      ),
    snoozeUpdate: (identity: string) =>
      post<HostUpdateStatus>("/api/update/snooze", { identity }),
    snapshot: (sessionId?: string | null) =>
      request<ActiveSnapshot>(`/api/snapshot${detailQuery(sessionId)}`),
    olderTranscript: (
      sessionId: string,
      cursor: string,
      signal?: AbortSignal,
    ) =>
      request<TranscriptPage>(
        `/api/transcript/older?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal },
      ),
    transcriptActivity: (
      sessionId: string,
      cursor: string,
      signal?: AbortSignal,
    ) =>
      request<TranscriptActivityPage>(
        `/api/transcript/activity?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal },
      ),
    transcriptUserTurns: (
      sessionId: string,
      start?: number,
      signal?: AbortSignal,
    ) =>
      request<UserTurnIndexPage>(
        `/api/transcript/user-turns?sessionId=${encodeURIComponent(sessionId)}${start === undefined ? "" : `&start=${start}`}`,
        { signal },
      ),
    transcriptUserTurn: (
      sessionId: string,
      id: string,
      cursor?: string,
      signal?: AbortSignal,
    ) =>
      request<UserTurnTranscriptPage>(
        `/api/transcript/user-turn?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
    lastAssistantText: (
      sessionId: string,
      viewId: string,
      signal?: AbortSignal,
    ) =>
      request<{ text: string | null }>(
        `/api/transcript/assistant-text?sessionId=${encodeURIComponent(sessionId)}&viewId=${encodeURIComponent(viewId)}`,
        { signal },
      ),
    composerHistory: (sessionId: string, start = 0) =>
      request<ComposerHistoryPage>(
        `/api/composer/history?sessionId=${encodeURIComponent(sessionId)}&start=${start}`,
      ),
    branchTree: (
      sessionId: string,
      query: BranchTreeQuery = {},
      signal?: AbortSignal,
    ) =>
      request<BranchTreeResponse>(
        `/api/branches/tree?${new URLSearchParams({ sessionId, ...query }).toString()}`,
        { signal },
      ),
    branchEntry: (body: BranchEntryRequest, signal?: AbortSignal) =>
      request<BranchEntryResponse>(
        `/api/branches/entry?${new URLSearchParams({
          sessionId: body.sessionId,
          viewId: body.viewId,
          targetId: body.targetId,
          offset: String(body.offset ?? 0),
          ...(body.format ? { format: body.format } : {}),
        }).toString()}`,
        { signal },
      ),
    branchImage: (
      body: BranchEntryRequest,
      index: number,
      signal?: AbortSignal,
    ) =>
      observeRequest(signal, { mutation: false }, async (signal) => {
        const response = await applicationFetch(
          `/api/branches/image?${new URLSearchParams({
            sessionId: body.sessionId,
            viewId: body.viewId,
            targetId: body.targetId,
            index: String(index),
          }).toString()}`,
          {
            signal,
          },
        );
        await ensureOk(response);
        return response.blob();
      }),
    cloneBranch: (body: BranchCloneRequest) =>
      post<BranchForkResponse>(
        "/api/branches/clone",
        body,
        {},
        { timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS },
      ),
    navigateBranch: (body: BranchNavigateRequest, signal?: AbortSignal) =>
      post<BranchNavigateResponse>(
        "/api/branches/navigate",
        body,
        { signal },
        { timeoutMs: null },
      ),
    forkBranch: (body: BranchForkRequest) =>
      post<BranchForkResponse>(
        "/api/branches/fork",
        body,
        {},
        {
          timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS,
        },
      ),
    sessions: (query: string, offset = 0, limit = 40, signal?: AbortSignal) =>
      request<SessionListResponse>(
        `/api/sessions?q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
        { signal },
      ),
    refreshSessions: () => post<{ ok: boolean }>("/api/sessions/refresh"),
    sessionsByIds: (ids: string[], signal?: AbortSignal) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        "/api/sessions/by-id",
        { ids },
        { signal },
        { mutation: false },
      ),
    sessionsByCwds: (cwds: string[]) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        "/api/sessions/by-cwd",
        { cwds },
        {},
        { mutation: false },
      ),
    openSession: (id: string, signal?: AbortSignal) =>
      post<SessionOpenResponse>("/api/sessions/open", { id }, { signal }),
    branchLeaves: (sessionId: string) =>
      request<BranchLeavesResponse>(
        `/api/branches/leaves?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    selectBranch: (sessionId: string, leafId: string) =>
      post<ActiveSnapshot>("/api/branches/select", {
        sessionId,
        leafId,
      }),
    takeOverSession: (sessionId: string) =>
      post<ActiveSnapshot>("/api/sessions/takeover", { sessionId }),
    resumeCommand: (sessionId: string) =>
      request<{ command: string; projectDirectoryMissing?: boolean }>(
        `/api/sessions/resume-command?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    deselectSession: (signal?: AbortSignal) =>
      post<ActiveSnapshot>("/api/sessions/deselect", undefined, {
        signal,
      }),
    newSession: (
      cwd: string,
      options: NewSessionOptions = {},
      signal?: AbortSignal,
    ) =>
      post<ActiveSnapshot>(
        "/api/sessions/new",
        { cwd, ...options },
        { signal },
        {
          timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS,
        },
      ),
    refreshModels: (sessionId?: string, cwd?: string, inherit = false) =>
      request<ModelCatalogResponse>(
        `/api/models?${new URLSearchParams({
          ...(sessionId ? { sessionId } : {}),
          ...(cwd ? { cwd } : {}),
          ...(inherit ? { inherit: "1" } : {}),
        })}`,
      ),
    mcpConfig: (owner: { sessionId?: string; cwd?: string }) =>
      request<McpConfigSnapshot>(`/api/mcp-config?${settingsQuery(owner)}`),
    mcpConnection: (
      owner: { sessionId?: string; cwd?: string },
      input: McpConnectionRead,
    ) =>
      request<McpConnectionValues>(
        `/api/mcp-config/connection?${settingsQuery(owner)}`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    editMcpConfig: (
      owner: { sessionId?: string; cwd?: string },
      edit: McpConfigEdit,
    ) =>
      request<McpConfigWriteResult>(
        `/api/mcp-config?${settingsQuery(owner)}`,
        { method: "PATCH", body: JSON.stringify(edit) },
        { mutation: true },
      ),
    modelSettings: (owner: { sessionId?: string; cwd?: string }) =>
      request<ModelSettingsSnapshot>(
        `/api/model-settings?${settingsQuery(owner)}`,
      ),
    saveModelPreferences: (
      owner: { sessionId?: string; cwd?: string },
      revision: string,
      patch: ModelPreferencesPatch,
    ) =>
      request<ModelSettingsWriteResult>(
        `/api/model-settings?${settingsQuery(owner)}`,
        { method: "PATCH", body: JSON.stringify({ revision, patch }) },
        { mutation: true },
      ),
    editModelConfig: (
      owner: { sessionId?: string; cwd?: string },
      revision: string,
      edit: ModelConfigEdit,
    ) =>
      request<ModelSettingsWriteResult>(
        `/api/model-settings/config?${settingsQuery(owner)}`,
        { method: "PATCH", body: JSON.stringify({ revision, edit }) },
        { mutation: true },
      ),
    providerAuth: (
      owner: { sessionId?: string; cwd?: string },
      operation: ProviderAuthOperation,
    ) =>
      post<{ result: ProviderAuthResult }>(
        `/api/provider-auth?${settingsQuery(owner)}`,
        operation,
        {},
        {
          mutation:
            operation.operation !== "providers" &&
            operation.operation !== "status",
        },
      ),
    newSessionThinking: (
      cwd: string,
      provider: string,
      modelId: string,
      current: ThinkingLevel,
    ) =>
      request<{ level: ThinkingLevel }>(
        `/api/new-session/thinking?${new URLSearchParams({ cwd, provider, modelId, current })}`,
      ),
    searchNewSessionFiles: (
      cwd: string,
      query: string,
      limit = 50,
      showHidden = false,
    ) =>
      request<ProjectFileSearchResult & { cwd: string }>(
        `/api/new-session/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=${limit}${showHidden ? "&showHidden=1" : ""}`,
      ),
    renameSession: (sessionId: string, name: string) =>
      post<{ ok: boolean }>("/api/sessions/rename", { sessionId, name }),
    deleteSession: (sessionId: string) =>
      request<SessionDeleteResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      ),
    clearHiddenSessions: (sessionIds: string[], projectCwd?: string) =>
      post<HiddenClearResponse>("/api/sessions/clear-hidden", {
        sessionIds,
        projectCwd,
      }),
    terminals: (cwd?: string) =>
      request<TerminalCatalogResponse>(
        cwd
          ? `/api/terminals?cwd=${encodeURIComponent(cwd)}`
          : "/api/terminals",
      ),
    retryTerminalOperation: (key: string) => terminalOperations.retry(key),
    createTerminal: (body: TerminalCreateRequest) =>
      terminalOperations.run<TerminalDescriptor>(
        "/api/terminals",
        "POST",
        body,
      ),
    renameTerminal: (id: string, body: TerminalRenameRequest) =>
      terminalOperations.run<TerminalDescriptor>(
        `/api/terminals/${encodeURIComponent(id)}`,
        "PATCH",
        body,
      ),
    reorderTerminals: (body: TerminalReorderRequest) =>
      terminalOperations.run<TerminalCatalogResponse>(
        "/api/terminals/reorder",
        "POST",
        body,
      ),
    restartTerminal: (id: string) =>
      terminalOperations.run<TerminalDescriptor>(
        `/api/terminals/${encodeURIComponent(id)}/restart`,
        "POST",
      ),
    removeTerminal: (id: string, force = false) =>
      terminalOperations.run<TerminalRemoveResponse>(
        `/api/terminals/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
        "DELETE",
      ),
    terminalAttachTicket: (id: string, signal?: AbortSignal) =>
      post<TerminalAttachTicketResponse>(
        `/api/terminals/${encodeURIComponent(id)}/attach-ticket`,
        undefined,
        { signal },
      ),
    terminalSettings: () =>
      request<TerminalServiceSettings>("/api/terminal-settings"),
    updateTerminalSettings: (body: TerminalServiceSettingsPatch) =>
      terminalOperations.run<TerminalServiceSettings>(
        "/api/terminal-settings",
        "PATCH",
        body,
      ),
    clearTerminalHistory: () =>
      terminalOperations.run<void>("/api/terminal-history", "DELETE"),
    prompt: (body: PromptDeliveryRequest, signal?: AbortSignal) =>
      withTransportMeasure("prompt-confirmation", () =>
        deliverPrompt(body, signal),
      ),
    nativeCommand: (body: HostNativeCommandRequest, signal?: AbortSignal) =>
      post<HostNativeCommandResponse>(
        "/api/control/native-command",
        body,
        { signal },
        { timeoutMs: null },
      ),
    piChangelog: () =>
      request<{ version: string; markdown: string }>("/api/pi/changelog"),
    exportSession: (body: SessionExportRequest) =>
      post<SessionExportResponse>("/api/sessions/export", body, undefined, {
        timeoutMs: null,
      }),
    exportDownload: (sessionId: string, id: string) =>
      observeRequest(
        undefined,
        { mutation: false, timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS },
        async (signal) => {
          const response = await applicationFetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(id)}`,
            {
              signal,
            },
          );
          await ensureOk(response);
          return response.blob();
        },
      ),
    abort: (sessionId: string, identity: PendingOperationIdentity) =>
      post<PendingRecovery>(
        "/api/control/abort",
        {
          sessionId,
          operationId: identity.operationId,
          authorityId: identity.authorityId,
          expectedViewId: identity.expectedViewId,
        },
        {},
        { timeoutMs: null },
      ),
    recoverPending: (sessionId: string, identity: PendingOperationIdentity) =>
      post<PendingRecovery>(
        "/api/pending/recover",
        {
          sessionId,
          operationId: identity.operationId,
          authorityId: identity.authorityId,
          expectedViewId: identity.expectedViewId,
        },
        {},
        { timeoutMs: null },
      ),
    pendingOperation: ({ operationId, ...query }: PendingOperationRequest) =>
      request<PendingRecovery>(
        `/api/pending/operations/${encodeURIComponent(operationId)}?${new URLSearchParams(query)}`,
      ),
    pendingText: (body: PendingReadRequest, signal?: AbortSignal) =>
      post<PendingCopyContent>(
        "/api/pending/text",
        body,
        { signal },
        { mutation: false },
      ),
    clearPending: (sessionId: string) =>
      post<{ ok: boolean }>("/api/pending/clear", { sessionId }),
    cycleModel: (sessionId: string, direction: 1 | -1) =>
      post<unknown>("/api/control/model-cycle", {
        sessionId,
        direction,
      }),
    setModel: (sessionId: string, provider: string, modelId: string) =>
      post<ModelSelectionResponse>("/api/control/model", {
        sessionId,
        provider,
        modelId,
      }),
    setThinkingLevel: (sessionId: string, level: string) =>
      post<ModelSelectionResponse>("/api/control/thinking", {
        sessionId,
        level,
      }),
    setAutoCompaction: (sessionId: string, enabled: boolean) =>
      post<{ ok: boolean }>("/api/control/auto-compaction", {
        sessionId,
        enabled,
      }),
    setAutoRetry: (sessionId: string, enabled: boolean) =>
      post<{ ok: boolean }>("/api/control/auto-retry", {
        sessionId,
        enabled,
      }),
    setSteeringMode: (sessionId: string, mode: PiMessageDeliveryMode) =>
      post<{ ok: boolean }>("/api/control/steering-mode", {
        sessionId,
        mode,
      }),
    setFollowUpMode: (sessionId: string, mode: PiMessageDeliveryMode) =>
      post<{ ok: boolean }>("/api/control/follow-up-mode", {
        sessionId,
        mode,
      }),
    uploadAttachments: (files: File[], signal?: AbortSignal) =>
      uploadFiles(files, signal),
    attachmentPreview: (id: string, signal?: AbortSignal) =>
      observeRequest(signal, { mutation: false }, async (signal) => {
        const response = await applicationFetch(
          `/api/attachments/${encodeURIComponent(id)}/image`,
          {
            signal,
          },
        );
        await ensureOk(response);
        return response.blob();
      }),
    deleteAttachment: (id: string) =>
      request<{ ok: boolean }>(`/api/attachments/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    searchFiles: (
      sessionId: string,
      query: string,
      limit = 50,
      signal?: AbortSignal,
      showHidden = false,
    ) =>
      request<ProjectFileSearchResult>(
        `/api/files?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}&limit=${limit}${showHidden ? "&showHidden=1" : ""}`,
        { signal },
      ),
    listFiles: (
      sessionId: string,
      dir: string,
      options: {
        signal?: AbortSignal;
        refresh?: boolean;
        showHidden?: boolean;
      } = {},
    ) =>
      request<{ entries: ProjectDirEntry[]; truncated?: boolean }>(
        `/api/files/list?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}${options.refresh ? "&refresh=1" : ""}${options.showHidden ? "&showHidden=1" : ""}`,
        { signal: options.signal },
      ),
    gitStatus: (sessionId: string, signal?: AbortSignal) =>
      request<GitStatusResponse>(
        `/api/git/status?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      ),
    gitDiff: (sessionId: string, pathId: string, signal?: AbortSignal) =>
      post<GitDiffResponse>(
        "/api/git/diff",
        { sessionId, pathId },
        { signal },
        { mutation: false },
      ),
    browseHostRoots: () => request<HostRootsResponse>("/api/host/roots"),
    browseHostDirs: (path?: string, showHidden = false) => {
      const query = new URLSearchParams();
      if (path) query.set("path", path);
      if (showHidden) query.set("showHidden", "1");
      return request<HostDirListing>(
        `/api/host/dirs${query.size ? `?${query}` : ""}`,
      );
    },
    listResources: (
      sessionId: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) =>
      post<SessionResourceListResponse>(
        "/api/resources/list",
        {
          sessionId,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        },
        { signal: options.signal },
        { mutation: false },
      ),
    probeResources: (
      sessionId: string,
      references: string[],
      signal?: AbortSignal,
    ) =>
      post<ResourceProbeResponse>(
        "/api/resources/probe",
        { sessionId, references },
        { signal },
        { mutation: false },
      ),
    resolveResource: (
      sessionId: string,
      reference: string,
      signal?: AbortSignal,
      workspacePath?: string,
    ) =>
      post<ResourceDescriptor>(
        "/api/resources/resolve",
        {
          sessionId,
          reference,
          ...(workspacePath !== undefined ? { workspacePath } : {}),
        },
        { signal },
        { mutation: false },
      ),
    showInFileManager: (
      sessionId: string,
      reference: string,
      workspacePath?: string,
      directory = false,
    ) =>
      post<{ ok: true }>("/api/resources/show-in-file-manager", {
        sessionId,
        reference,
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        directory,
      }),
    createHtmlPreview: (id: string, sessionId: string, html: string) =>
      post<HtmlPreviewResponse>(
        `/api/resources/${encodeURIComponent(id)}/interactive`,
        { sessionId, html },
      ),
    deleteHtmlPreview: (id: string, sessionId: string) =>
      request<void>(
        `/api/html-previews/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      ),
    resourceDownloadTicket: (
      id: string,
      sessionId: string,
      signal: AbortSignal,
    ) =>
      post<{ ticket: string; expiresAt: number }>(
        `/api/resources/${encodeURIComponent(id)}/download-ticket`,
        { sessionId },
        { signal },
        { mutation: false },
      ),
    resourceContent: (
      id: string,
      sessionId: string,
      options?: ResourceContentOptions,
    ) => fetchResourceContent(id, sessionId, options),
    respondExtensionUi: (payload: Record<string, unknown>) =>
      post<{ ok: boolean }>("/api/extension-ui", payload),
    setPresentationAdapterEnabled: (id: string, enabled: boolean) =>
      request<{
        configuration: ToolPresentationConfiguration;
        adapters?: PresentationAdapterInfo[];
        warning?: string;
        preferences: InspirePreferences;
      }>("/api/presentation-adapters/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    preferences: () => request<InspirePreferences>("/api/preferences"),
    savePreferences: (patch: Partial<InspirePreferences>) =>
      request<InspirePreferences>("/api/preferences", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  };
}

export type Api = ReturnType<typeof createApi>;

export function terminalUrl(ticket: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal?ticket=${encodeURIComponent(ticket)}`;
}

function detailQuery(sessionId: string | null | undefined): string {
  return sessionId === undefined
    ? ""
    : `?detail=${encodeURIComponent(sessionId ?? "")}`;
}

export function eventsUrl(
  ticket: string,
  snapshotDigest: string | null,
  sessionId: string | null,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ ticket });
  if (snapshotDigest) query.set("snapshot", snapshotDigest);
  query.set("detail", sessionId ?? "");
  return `${protocol}//${window.location.host}/events?${query}`;
}
