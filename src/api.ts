import type {
  ActiveSnapshot,
  BootstrapResponse,
  BranchForkRequest,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  ComposerHistoryPage,
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
  HiddenClearResponse,
  HostDirListing,
  HostRootsResponse,
  InspirePreferences,
  NewSessionDefaults,
  NewSessionOptions,
  PendingManagementAction,
  PendingManagementIntent,
  PendingQueues,
  PiUpdateCheckResponse,
  ProjectDirEntry,
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  ResourceDescriptor,
  ResourceProbeResponse,
  SessionDeleteResponse,
  SessionListResponse,
  TranscriptActivityPage,
  TranscriptPage,
  UpdateCheckResponse,
  UploadedAttachment,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts";
import type { SessionResourceListResponse } from "../shared/resource-references";
import { withTransportMeasure } from "./transport-performance";

export type { PendingManagementAction, PendingManagementIntent };

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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request did not produce a trustworthy application response. A write's
 * outcome is therefore unknown until its operation identity is checked. */
export const PROMPT_CONFIRMATION_TIMEOUT_MS = 30_000;

export class ApiTransportError extends Error {
  constructor(public phase: "request" | "response") {
    super(
      phase === "request"
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
  try {
    const body = (await response.json()) as {
      error?: string;
      matches?: unknown;
      code?: unknown;
    };
    if (body.error) message = body.error;
    if (Array.isArray(body.matches)) matches = body.matches.map(String);
    if (typeof body.code === "string") code = body.code;
  } catch {
    // keep status-based message
  }
  throw new ApiError(
    response.status,
    message,
    matches,
    code,
    response.headers.get("X-Inspire-Edge") ?? undefined,
    response.headers.get("X-Inspire-Authority") ?? undefined,
  );
}

function authorizationHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  token: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await applicationFetch(path, {
    ...init,
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
): Promise<{ attachments: UploadedAttachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  // No Content-Type header: the browser sets the multipart boundary.
  const response = await applicationFetch("/api/attachments", {
    method: "POST",
    credentials: "same-origin",
    headers: authorizationHeader(token),
    body: form,
  });
  await ensureOk(response);
  return responseJson<{ attachments: UploadedAttachment[] }>(response);
}

function post<T>(
  token: string | null,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  return request<T>(token, path, {
    ...init,
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

async function deliverPrompt(
  token: string | null,
  body: PromptDeliveryRequest,
): Promise<PromptAcceptedResponse> {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    PROMPT_CONFIRMATION_TIMEOUT_MS,
  );
  try {
    return await post<PromptAcceptedResponse>(token, "/api/prompt", body, {
      signal: controller.signal,
    });
  } catch (error) {
    // Prompt acceptance may already have crossed the public edge. Convert only
    // this owned timeout into an unknown transport outcome so Composer retains
    // and safely reuses the operation identity.
    if (aborted(error)) throw new ApiTransportError("request");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function createApi(token: string | null = null) {
  return {
    /** A successful bearer-authenticated bootstrap establishes the pairing
     * cookie. Retire the launch credential before any later API or event-stream
     * request so a long-lived page cannot keep replaying it. */
    retireBearer: () => {
      token = null;
    },
    bootstrap: (signal?: AbortSignal) =>
      withTransportMeasure("bootstrap-confirmation", () =>
        request<BootstrapResponse>(token, "/api/bootstrap", { signal }),
      ),
    update: (refresh = false) =>
      request<UpdateCheckResponse>(
        token,
        `/api/update${refresh ? "?refresh=1" : ""}`,
      ),
    piUpdate: (refresh = false) =>
      request<PiUpdateCheckResponse>(
        token,
        `/api/pi-update${refresh ? "?refresh=1" : ""}`,
      ),
    snapshot: () => request<ActiveSnapshot>(token, "/api/snapshot"),
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
    composerHistory: (sessionId: string, start = 0) =>
      request<ComposerHistoryPage>(
        token,
        `/api/composer/history?sessionId=${encodeURIComponent(sessionId)}&start=${start}`,
      ),
    branchTree: (sessionId: string) =>
      request<BranchTreeResponse>(
        token,
        `/api/branches/tree?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    navigateBranch: (body: BranchNavigateRequest) =>
      post<BranchNavigateResponse>(token, "/api/branches/navigate", body),
    forkBranch: (body: BranchForkRequest) =>
      post<BranchForkResponse>(token, "/api/branches/fork", body),
    sessions: (query: string, offset = 0, limit = 40) =>
      request<SessionListResponse>(
        token,
        `/api/sessions?q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
      ),
    refreshSessions: () =>
      post<{ ok: boolean }>(token, "/api/sessions/refresh"),
    sessionsByIds: (ids: string[]) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        token,
        "/api/sessions/by-id",
        { ids },
      ),
    sessionsByCwds: (cwds: string[]) =>
      post<{ sessions: SessionListResponse["sessions"] }>(
        token,
        "/api/sessions/by-cwd",
        { cwds },
      ),
    openSession: (id: string) =>
      post<ActiveSnapshot>(token, "/api/sessions/open", { id }),
    deselectSession: () =>
      post<ActiveSnapshot>(token, "/api/sessions/deselect"),
    newSession: (cwd: string, options: NewSessionOptions = {}) =>
      post<ActiveSnapshot>(token, "/api/sessions/new", { cwd, ...options }),
    newSessionDefaults: (cwd: string) =>
      request<NewSessionDefaults>(
        token,
        `/api/new-session/defaults?cwd=${encodeURIComponent(cwd)}`,
      ),
    searchNewSessionFiles: (cwd: string, query: string, limit = 50) =>
      request<{ cwd: string; files: ProjectFileResult[] }>(
        token,
        `/api/new-session/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&limit=${limit}`,
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
    prompt: (body: PromptDeliveryRequest) =>
      withTransportMeasure("prompt-confirmation", () =>
        deliverPrompt(token, body),
      ),
    abort: (sessionId: string) =>
      post<{ ok: boolean }>(token, "/api/control/abort", { sessionId }),
    managePending: (sessionId: string, action: PendingManagementAction) =>
      post<{ pendingQueues: PendingQueues }>(token, "/api/pending", {
        sessionId,
        ...action,
      }),
    pendingMessageTexts: (sessionId: string, messageIds: string[]) =>
      post<{ messages: Array<{ id: string; text: string }> }>(
        token,
        "/api/pending/text",
        { sessionId, messageIds },
      ),
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
    uploadAttachments: (files: File[]) => uploadFiles(token, files),
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
    ) =>
      request<{ files: ProjectFileResult[] }>(
        token,
        `/api/files?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}&limit=${limit}`,
        { signal },
      ),
    listFiles: (
      sessionId: string,
      dir: string,
      options: { signal?: AbortSignal; refresh?: boolean } = {},
    ) =>
      request<{ entries: ProjectDirEntry[] }>(
        token,
        `/api/files/list?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}${options.refresh ? "&refresh=1" : ""}`,
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
      ),
    browseHostRoots: () => request<HostRootsResponse>(token, "/api/host/roots"),
    browseHostDirs: (path?: string) =>
      request<HostDirListing>(
        token,
        path
          ? `/api/host/dirs?path=${encodeURIComponent(path)}`
          : "/api/host/dirs",
      ),
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
      ),
    resourceContent: (
      id: string,
      sessionId: string,
      options?: ResourceContentOptions,
    ) => fetchResourceContent(token, id, sessionId, options),
    respondExtensionUi: (payload: Record<string, unknown>) =>
      post<{ ok: boolean }>(token, "/api/extension-ui", payload),
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

export function eventsUrl(
  token: string | null = null,
  snapshotDigest: string | null = null,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams();
  if (token) query.set("token", token);
  if (snapshotDigest) query.set("snapshot", snapshotDigest);
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${protocol}//${window.location.host}/events${suffix}`;
}
