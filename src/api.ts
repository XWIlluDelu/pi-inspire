import type {
  ActiveSnapshot,
  BootstrapResponse,
  BranchCloneRequest,
  BranchEntryRequest,
  BranchEntryResponse,
  BranchForkRequest,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeQuery,
  BranchTreeResponse,
  ComposerHistoryPage,
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
  HiddenClearResponse,
  HostDirListing,
  HostNativeCommandRequest,
  HostNativeCommandResponse,
  HostRootsResponse,
  HostUpdateStatus,
  InspirePreferences,
  InspireUpdateCheckResult,
  NewSessionDefaults,
  NewSessionOptions,
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
  SessionListResponse,
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

// Deterministic development-only token, matched by the dev:host script.
// Production authentication is an origin-scoped HttpOnly pairing cookie; the
// query token remains only long enough to establish that pairing.
const DEV_TOKEN = "inspire-dev-token";

export function resolveToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return import.meta.env.DEV ? DEV_TOKEN : null;
}

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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const PROMPT_CONFIRMATION_TIMEOUT_MS = 30_000;
// Leave room for the Host's 30-second Pi reads and response transfer.
export const HTTP_OBSERVATION_TIMEOUT_MS = 45_000;
export const LONG_HTTP_OBSERVATION_TIMEOUT_MS = 120_000;

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
        ? "INSΠRE could not confirm this operation's outcome. It may still complete. Inspect the current state before trying again."
        : timedOut
          ? "The INSΠRE response deadline expired. Try the read again."
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
    return await fetch(input, init);
  } catch (error) {
    if (aborted(error)) throw error;
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
  try {
    const body = (await response.json()) as {
      error?: string;
      matches?: unknown;
      code?: unknown;
      outcomeUnknown?: unknown;
    };
    if (body.error) message = body.error;
    if (Array.isArray(body.matches)) matches = body.matches.map(String);
    if (typeof body.code === "string") code = body.code;
    outcomeUnknown = body.outcomeUnknown === true;
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
  );
}

function authorizationHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  token: string | null,
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
        credentials: "same-origin",
        headers: {
          ...authorizationHeader(token),
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

async function fetchResourceContent(
  token: string | null,
  id: string,
  sessionId: string,
  options: ResourceContentOptions = {},
): Promise<ResourceContentResponse> {
  const response = await applicationFetch(
    `/api/resources/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`,
    {
      signal: options.signal,
      credentials: "same-origin",
      headers: {
        ...authorizationHeader(token),
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
    throw new ApiError(502, "The resource response exceeded its byte limit");
  }
  return { blob, totalSize: contentTotalSize(response, blob) };
}

async function uploadFiles(
  token: string | null,
  files: File[],
  signal?: AbortSignal,
): Promise<{ attachments: UploadedAttachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  // Allow two minutes of overhead plus transfer time at 128 KiB/s. The raw
  // attachment cap also bounds this budget; uploads never inherit Pi's
  // completion-driven command waits.
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const timeoutMs =
    LONG_HTTP_OBSERVATION_TIMEOUT_MS + Math.ceil(bytes / 131_072) * 1_000;
  return observeRequest(
    signal,
    { mutation: true, timeoutMs },
    async (signal) => {
      // No Content-Type header: the browser sets the multipart boundary.
      const response = await applicationFetch("/api/attachments", {
        method: "POST",
        signal,
        credentials: "same-origin",
        headers: authorizationHeader(token),
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
            request(token, `/api/attachments/${encodeURIComponent(item.id)}`, {
              method: "DELETE",
            }).catch(() => undefined),
          ),
        );
      return result;
    },
  );
}

function post<T>(
  token: string | null,
  path: string,
  body?: unknown,
  init: RequestInit = {},
  options: ObservationOptions = {},
): Promise<T> {
  return request<T>(
    token,
    path,
    {
      ...init,
      method: "POST",
      body: JSON.stringify(body ?? {}),
    },
    options,
  );
}

async function observePrompt(
  token: string | null,
  path: string,
  body: PromptDeliveryRequest | undefined,
  signal?: AbortSignal,
): Promise<PromptDeliveryResponse> {
  if (signal?.aborted) throw new ApiTransportError("request");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = window.setTimeout(cancel, PROMPT_CONFIRMATION_TIMEOUT_MS);
  try {
    const init = { signal: controller.signal };
    return await (body
      ? post<PromptDeliveryResponse>(token, path, body, init)
      : request<PromptDeliveryResponse>(token, path, init));
  } catch (error) {
    // This ends only one browser observation, not the Host/Pi operation.
    if (aborted(error)) throw new ApiTransportError("request");
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function waitForPromptPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      if (signal?.aborted) reject(new ApiTransportError("request"));
      else resolve();
    };
    const timer = window.setTimeout(finish, 250);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

async function deliverPrompt(
  token: string | null,
  body: PromptDeliveryRequest,
  signal?: AbortSignal,
): Promise<PromptAcceptedResponse> {
  let first = true;
  for (;;) {
    let response: PromptDeliveryResponse;
    try {
      response = await observePrompt(
        token,
        first
          ? "/api/prompt"
          : `/api/prompt/${encodeURIComponent(body.operationId)}?authorityId=${encodeURIComponent(body.authorityId)}`,
        first ? body : undefined,
        signal,
      );
    } catch (error) {
      // Even an authenticated 401/404/500 can refuse the observation without
      // saying anything about an earlier dispatch. Only the retained operation
      // receipt may declare that same operation rejected.
      if (
        error instanceof ApiError &&
        !(
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
      throw new ApiTransportError("response");
    // Poll the receipt, not another delivery of potentially large attachments.
    // Pi may still be compacting, running an input hook, or awaiting a dialog.
    first = false;
    await waitForPromptPoll(signal);
  }
}

export function createApi(token: string | null = null) {
  return {
    herdrStatus: () =>
      request<HerdrEnhancementStatus>(token, "/api/host/herdr", {
        signal: AbortSignal.timeout(10_000),
      }),
    hostRestartStatus: () =>
      request<HostRestartStatus>(token, "/api/host/restart", {
        signal: AbortSignal.timeout(10_000),
      }),
    restartHost: (intent: HostRestartRequest) =>
      request<HostRestartOperation>(token, "/api/host/restart", {
        method: "POST",
        body: JSON.stringify(intent),
        signal: AbortSignal.timeout(10_000),
      }),
    /** A successful bearer-authenticated bootstrap establishes the pairing
     * cookie. Retire the launch credential before any later API or event-stream
     * request so a long-lived page cannot keep replaying it. */
    retireBearer: () => {
      token = null;
    },
    bootstrap: (signal?: AbortSignal, sessionId?: string | null) =>
      withTransportMeasure("bootstrap-confirmation", () =>
        request<BootstrapResponse>(
          token,
          `/api/bootstrap${detailQuery(sessionId)}`,
          { signal },
        ),
      ),
    update: (refresh = false) =>
      request<InspireUpdateCheckResult>(
        token,
        `/api/update${refresh ? "?refresh=1" : ""}`,
      ),
    piUpdate: (refresh = false) =>
      request<PiUpdateCheckResult>(
        token,
        `/api/pi-update${refresh ? "?refresh=1" : ""}`,
      ),
    snoozeUpdate: (identity: string) =>
      post<HostUpdateStatus>(token, "/api/update/snooze", { identity }),
    snapshot: (sessionId?: string | null) =>
      request<ActiveSnapshot>(token, `/api/snapshot${detailQuery(sessionId)}`),
    olderTranscript: (
      sessionId: string,
      cursor: string,
      signal?: AbortSignal,
    ) =>
      request<TranscriptPage>(
        token,
        `/api/transcript/older?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}&deferActivity=1`,
        { signal },
      ),
    transcriptActivity: (
      sessionId: string,
      cursor: string,
      signal?: AbortSignal,
    ) =>
      request<TranscriptActivityPage>(
        token,
        `/api/transcript/activity?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal },
      ),
    transcriptUserTurns: (
      sessionId: string,
      start?: number,
      signal?: AbortSignal,
    ) =>
      request<UserTurnIndexPage>(
        token,
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
        token,
        `/api/transcript/user-turn?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
    lastAssistantText: (sessionId: string, viewId: string) =>
      request<{ text: string | null }>(
        token,
        `/api/transcript/assistant-text?sessionId=${encodeURIComponent(sessionId)}&viewId=${encodeURIComponent(viewId)}`,
      ),
    composerHistory: (sessionId: string, start = 0) =>
      request<ComposerHistoryPage>(
        token,
        `/api/composer/history?sessionId=${encodeURIComponent(sessionId)}&start=${start}`,
      ),
    branchTree: (
      sessionId: string,
      query: BranchTreeQuery = {},
      signal?: AbortSignal,
    ) =>
      request<BranchTreeResponse>(
        token,
        `/api/branches/tree?${new URLSearchParams({ sessionId, ...query }).toString()}`,
        { signal },
      ),
    branchEntry: (body: BranchEntryRequest, signal?: AbortSignal) =>
      request<BranchEntryResponse>(
        token,
        `/api/branches/entry?${new URLSearchParams({
          sessionId: body.sessionId,
          viewId: body.viewId,
          targetId: body.targetId,
          offset: String(body.offset ?? 0),
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
            credentials: "same-origin",
            headers: authorizationHeader(token),
          },
        );
        await ensureOk(response);
        return response.blob();
      }),
    cloneBranch: (body: BranchCloneRequest) =>
      post<BranchForkResponse>(
        token,
        "/api/branches/clone",
        body,
        {},
        { timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS },
      ),
    navigateBranch: (body: BranchNavigateRequest, signal?: AbortSignal) =>
      post<BranchNavigateResponse>(
        token,
        "/api/branches/navigate",
        body,
        { signal },
        { timeoutMs: null },
      ),
    forkBranch: (body: BranchForkRequest) =>
      post<BranchForkResponse>(
        token,
        "/api/branches/fork",
        body,
        {},
        {
          timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS,
        },
      ),
    sessions: (query: string, offset = 0, limit = 40, signal?: AbortSignal) =>
      request<SessionListResponse>(
        token,
        `/api/sessions?q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
        { signal },
      ),
    refreshSessions: () =>
      post<{ ok: boolean }>(token, "/api/sessions/refresh"),
    sessionsByIds: (ids: string[]) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        token,
        "/api/sessions/by-id",
        { ids },
        {},
        { mutation: false },
      ),
    sessionsByCwds: (cwds: string[]) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        token,
        "/api/sessions/by-cwd",
        { cwds },
        {},
        { mutation: false },
      ),
    openSession: (id: string, signal?: AbortSignal) =>
      post<ActiveSnapshot>(token, "/api/sessions/open", { id }, { signal }),
    deselectSession: (signal?: AbortSignal) =>
      post<ActiveSnapshot>(token, "/api/sessions/deselect", undefined, {
        signal,
      }),
    newSession: (
      cwd: string,
      options: NewSessionOptions = {},
      signal?: AbortSignal,
    ) =>
      post<ActiveSnapshot>(
        token,
        "/api/sessions/new",
        { cwd, ...options },
        { signal },
        {
          timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS,
        },
      ),
    newSessionDefaults: (cwd: string) =>
      request<NewSessionDefaults>(
        token,
        `/api/new-session/defaults?cwd=${encodeURIComponent(cwd)}`,
      ),
    searchNewSessionFiles: (
      cwd: string,
      query: string,
      limit = 50,
      showHidden = false,
    ) =>
      request<ProjectFileSearchResult & { cwd: string }>(
        token,
        `/api/new-session/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=${limit}${showHidden ? "&showHidden=1" : ""}`,
      ),
    renameSession: (sessionId: string, name: string) =>
      post<{ ok: boolean }>(token, "/api/sessions/rename", { sessionId, name }),
    deleteSession: (sessionId: string) =>
      request<SessionDeleteResponse>(
        token,
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      ),
    clearHiddenSessions: (sessionIds: string[]) =>
      post<HiddenClearResponse>(token, "/api/sessions/clear-hidden", {
        sessionIds,
      }),
    terminals: (cwd?: string) =>
      request<TerminalCatalogResponse>(
        token,
        cwd
          ? `/api/terminals?cwd=${encodeURIComponent(cwd)}`
          : "/api/terminals",
      ),
    retryTerminalOperation: (key: string) =>
      terminalOperations.retry(token, key),
    createTerminal: (body: TerminalCreateRequest) =>
      terminalOperations.run<TerminalDescriptor>(
        token,
        "/api/terminals",
        "POST",
        body,
      ),
    renameTerminal: (id: string, body: TerminalRenameRequest) =>
      terminalOperations.run<TerminalDescriptor>(
        token,
        `/api/terminals/${encodeURIComponent(id)}`,
        "PATCH",
        body,
      ),
    reorderTerminals: (body: TerminalReorderRequest) =>
      terminalOperations.run<TerminalCatalogResponse>(
        token,
        "/api/terminals/reorder",
        "POST",
        body,
      ),
    restartTerminal: (id: string) =>
      terminalOperations.run<TerminalDescriptor>(
        token,
        `/api/terminals/${encodeURIComponent(id)}/restart`,
        "POST",
      ),
    removeTerminal: (id: string, force = false) =>
      terminalOperations.run<TerminalRemoveResponse>(
        token,
        `/api/terminals/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
        "DELETE",
      ),
    terminalAttachTicket: (id: string, signal?: AbortSignal) =>
      post<TerminalAttachTicketResponse>(
        token,
        `/api/terminals/${encodeURIComponent(id)}/attach-ticket`,
        undefined,
        { signal },
      ),
    terminalSettings: () =>
      request<TerminalServiceSettings>(token, "/api/terminal-settings"),
    updateTerminalSettings: (body: TerminalServiceSettingsPatch) =>
      terminalOperations.run<TerminalServiceSettings>(
        token,
        "/api/terminal-settings",
        "PATCH",
        body,
      ),
    clearTerminalHistory: () =>
      terminalOperations.run<void>(token, "/api/terminal-history", "DELETE"),
    prompt: (body: PromptDeliveryRequest, signal?: AbortSignal) =>
      withTransportMeasure("prompt-confirmation", () =>
        deliverPrompt(token, body, signal),
      ),
    nativeCommand: (body: HostNativeCommandRequest, signal?: AbortSignal) =>
      post<HostNativeCommandResponse>(
        token,
        "/api/control/native-command",
        body,
        { signal },
        { timeoutMs: null },
      ),
    abort: (sessionId: string) =>
      post<PendingRecovery>(
        token,
        "/api/control/abort",
        { sessionId },
        {},
        { timeoutMs: null },
      ),
    recoverPending: (sessionId: string) =>
      post<PendingRecovery>(
        token,
        "/api/pending/recover",
        { sessionId },
        {},
        { timeoutMs: null },
      ),
    pendingText: (body: PendingReadRequest) =>
      post<{ text: string }>(
        token,
        "/api/pending/text",
        body,
        {},
        { mutation: false },
      ),
    clearPending: (sessionId: string) =>
      post<{ ok: boolean }>(token, "/api/pending/clear", { sessionId }),
    setModel: (sessionId: string, provider: string, modelId: string) =>
      post<unknown>(token, "/api/control/model", {
        sessionId,
        provider,
        modelId,
      }),
    setThinkingLevel: (sessionId: string, level: string) =>
      post<{ ok: boolean }>(token, "/api/control/thinking", {
        sessionId,
        level,
      }),
    setAutoCompaction: (sessionId: string, enabled: boolean) =>
      post<{ ok: boolean }>(token, "/api/control/auto-compaction", {
        sessionId,
        enabled,
      }),
    setAutoRetry: (sessionId: string, enabled: boolean) =>
      post<{ ok: boolean }>(token, "/api/control/auto-retry", {
        sessionId,
        enabled,
      }),
    setSteeringMode: (sessionId: string, mode: PiMessageDeliveryMode) =>
      post<{ ok: boolean }>(token, "/api/control/steering-mode", {
        sessionId,
        mode,
      }),
    setFollowUpMode: (sessionId: string, mode: PiMessageDeliveryMode) =>
      post<{ ok: boolean }>(token, "/api/control/follow-up-mode", {
        sessionId,
        mode,
      }),
    uploadAttachments: (files: File[], signal?: AbortSignal) =>
      uploadFiles(token, files, signal),
    attachmentPreview: (id: string, signal?: AbortSignal) =>
      observeRequest(signal, { mutation: false }, async (signal) => {
        const response = await applicationFetch(
          `/api/attachments/${encodeURIComponent(id)}/image`,
          {
            signal,
            credentials: "same-origin",
            headers: authorizationHeader(token),
          },
        );
        await ensureOk(response);
        return response.blob();
      }),
    deleteAttachment: (id: string) =>
      request<{ ok: boolean }>(
        token,
        `/api/attachments/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    searchFiles: (
      sessionId: string,
      query: string,
      limit = 50,
      signal?: AbortSignal,
      showHidden = false,
    ) =>
      request<ProjectFileSearchResult>(
        token,
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
        token,
        `/api/files/list?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}${options.refresh ? "&refresh=1" : ""}${options.showHidden ? "&showHidden=1" : ""}`,
        { signal: options.signal },
      ),
    gitStatus: (sessionId: string, signal?: AbortSignal) =>
      request<GitStatusResponse>(
        token,
        `/api/git/status?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      ),
    gitDiff: (
      sessionId: string,
      pathId: string,
      side: GitDiffSide,
      signal?: AbortSignal,
    ) =>
      post<GitDiffResponse>(
        token,
        "/api/git/diff",
        { sessionId, pathId, side },
        { signal },
        { mutation: false },
      ),
    browseHostRoots: () => request<HostRootsResponse>(token, "/api/host/roots"),
    browseHostDirs: (path?: string, showHidden = false) => {
      const query = new URLSearchParams();
      if (path) query.set("path", path);
      if (showHidden) query.set("showHidden", "1");
      return request<HostDirListing>(
        token,
        `/api/host/dirs${query.size ? `?${query}` : ""}`,
      );
    },
    listResources: (
      sessionId: string,
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) =>
      post<SessionResourceListResponse>(
        token,
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
        token,
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
        token,
        "/api/resources/resolve",
        {
          sessionId,
          reference,
          ...(workspacePath !== undefined ? { workspacePath } : {}),
        },
        { signal },
        { mutation: false },
      ),
    resourceContent: (
      id: string,
      sessionId: string,
      options?: ResourceContentOptions,
    ) => fetchResourceContent(token, id, sessionId, options),
    respondExtensionUi: (payload: Record<string, unknown>) =>
      post<{ ok: boolean }>(token, "/api/extension-ui", payload),
    preferences: () => request<InspirePreferences>(token, "/api/preferences"),
    savePreferences: (patch: Partial<InspirePreferences>) =>
      request<InspirePreferences>(token, "/api/preferences", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  };
}

export type Api = ReturnType<typeof createApi>;

export async function pairHost(token: string): Promise<void> {
  const response = await applicationFetch("/api/auth/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await ensureOk(response);
}

export function terminalUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal`;
}

function detailQuery(sessionId: string | null | undefined): string {
  return sessionId === undefined
    ? ""
    : `?detail=${encodeURIComponent(sessionId ?? "")}`;
}

export function eventsUrl(
  token: string | null = null,
  snapshotDigest: string | null = null,
  sessionId?: string | null,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams();
  if (token) query.set("token", token);
  if (snapshotDigest) query.set("snapshot", snapshotDigest);
  if (sessionId !== undefined) query.set("detail", sessionId ?? "");
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${protocol}//${window.location.host}/events${suffix}`;
}
