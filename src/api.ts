import type {
  ActiveSnapshot,
  BranchForkRequest,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  BootstrapResponse,
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
  HiddenClearResponse,
  HostDirListing,
  HostRootsResponse,
  InspirePreferences,
  NewSessionDefaults,
  NewSessionOptions,
  ProjectDirEntry,
  PromptRequest,
  ResourceDescriptor,
  ResourceProbeResponse,
  SessionDeleteResponse,
  SessionListResponse,
  TranscriptPage,
  UploadedAttachment,
} from "../shared/contracts";
import type { SessionResourceListResponse } from "../shared/resource-references";

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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `Request failed (${response.status})`;
  let matches: string[] | undefined;
  try {
    const body = (await response.json()) as {
      error?: string;
      matches?: unknown;
    };
    if (body.error) message = body.error;
    if (Array.isArray(body.matches)) matches = body.matches.map(String);
  } catch {
    // keep status-based message
  }
  throw new ApiError(response.status, message, matches);
}

function authorizationHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  token: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
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
  return (await response.json()) as T;
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
  const match = /^bytes\s+\d+-\d+\/(\d+)$/.exec(contentRange);
  const total = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(502, "The resource response has an invalid total size");
  }
  return total;
}

async function fetchResourceContent(
  token: string | null,
  id: string,
  sessionId: string,
  options: ResourceContentOptions = {},
): Promise<ResourceContentResponse> {
  const response = await fetch(
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
  const blob = await response.blob();
  return { blob, totalSize: contentTotalSize(response, blob) };
}

async function uploadFiles(
  token: string | null,
  files: File[],
): Promise<{ attachments: UploadedAttachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  // No Content-Type header: the browser sets the multipart boundary.
  const response = await fetch("/api/attachments", {
    method: "POST",
    credentials: "same-origin",
    headers: authorizationHeader(token),
    body: form,
  });
  await ensureOk(response);
  return (await response.json()) as { attachments: UploadedAttachment[] };
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

export function createApi(token: string | null = null) {
  return {
    bootstrap: () => request<BootstrapResponse>(token, "/api/bootstrap"),
    snapshot: () => request<ActiveSnapshot>(token, "/api/snapshot"),
    olderTranscript: (
      sessionId: string,
      cursor: string,
      signal?: AbortSignal,
    ) =>
      request<TranscriptPage>(
        token,
        `/api/transcript/older?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal },
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
    prompt: (body: PromptRequest) =>
      post<{ accepted: boolean }>(token, "/api/prompt", body),
    abort: (sessionId: string) =>
      post<{ ok: boolean }>(token, "/api/control/abort", { sessionId }),
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
    searchFiles: (sessionId: string, query: string, limit = 50) =>
      request<{ files: ProjectFileResult[] }>(
        token,
        `/api/files?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}&limit=${limit}`,
      ),
    listFiles: (sessionId: string, dir: string) =>
      request<{ entries: ProjectDirEntry[] }>(
        token,
        `/api/files/list?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}`,
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
    ) =>
      post<ResourceDescriptor>(
        token,
        "/api/resources/resolve",
        { sessionId, reference },
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
  const response = await fetch("/api/auth/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await ensureOk(response);
}

export function eventsUrl(token: string | null = null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}/events${query}`;
}
