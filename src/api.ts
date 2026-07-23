import type {
  ActiveSnapshot,
  BootstrapResponse,
  InspirePreferences,
  PromptRequest,
  ResourceDescriptor,
  SessionListResponse,
  UploadedAttachment,
} from "../shared/contracts";

export interface ProjectFileResult {
  path: string;
  name: string;
}

export interface ProjectDirEntry {
  name: string;
  type: "dir" | "file";
}

const TOKEN_KEY = "inspire.token";

// Deterministic development-only token, matched by the dev:host script.
// In production the host generates a random token per launch, so this value
// never authenticates there and no fallback applies.
export const DEV_TOKEN = "inspire-dev-token";

export function resolveToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored) return stored;
  return import.meta.env.DEV ? DEV_TOKEN : null;
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // keep status-based message
  }
  throw new ApiError(response.status, message);
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  await ensureOk(response);
  return (await response.json()) as T;
}

export interface ResourceContent {
  blob: Blob;
}

async function fetchResourceContent(token: string, id: string, sessionId: string, byteLimit?: number): Promise<ResourceContent> {
  const response = await fetch(`/api/resources/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(byteLimit ? { Range: `bytes=0-${Math.max(0, byteLimit - 1)}` } : {}),
    },
  });
  await ensureOk(response);
  return { blob: await response.blob() };
}

async function uploadFiles(token: string, files: File[]): Promise<{ attachments: UploadedAttachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  // No Content-Type header: the browser sets the multipart boundary.
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  await ensureOk(response);
  return (await response.json()) as { attachments: UploadedAttachment[] };
}

function post<T>(token: string, path: string, body?: unknown): Promise<T> {
  return request<T>(token, path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function createApi(token: string) {
  return {
    bootstrap: () => request<BootstrapResponse>(token, "/api/bootstrap"),
    snapshot: () => request<ActiveSnapshot>(token, "/api/snapshot"),
    sessions: (query: string, offset = 0, limit = 40) =>
      request<SessionListResponse>(
        token,
        `/api/sessions?q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
      ),
    refreshSessions: () => post<{ ok: boolean }>(token, "/api/sessions/refresh"),
    sessionsByIds: (ids: string[]) => post<{ sessions: SessionListResponse["sessions"] }>(token, "/api/sessions/by-id", { ids }),
    setSessionPinned: (id: string, pinned: boolean) => post<InspirePreferences>(token, "/api/sessions/pin", { id, pinned }),
    openSession: (id: string) => post<ActiveSnapshot>(token, "/api/sessions/open", { id }),
    newSession: (cwd: string, name?: string) => post<ActiveSnapshot>(token, "/api/sessions/new", { cwd, name }),
    renameSession: (name: string) => post<{ ok: boolean }>(token, "/api/sessions/rename", { name }),
    prompt: (body: PromptRequest) => post<{ accepted: boolean }>(token, "/api/prompt", body),
    abort: () => post<{ ok: boolean }>(token, "/api/control/abort"),
    setModel: (provider: string, modelId: string) =>
      post<unknown>(token, "/api/control/model", { provider, modelId }),
    setThinkingLevel: (level: string) => post<{ ok: boolean }>(token, "/api/control/thinking", { level }),
    uploadAttachments: (files: File[]) => uploadFiles(token, files),
    searchFiles: (query: string, limit = 50) =>
      request<{ files: ProjectFileResult[] }>(
        token,
        `/api/files?q=${encodeURIComponent(query)}&limit=${limit}`,
      ),
    listFiles: (dir: string) =>
      request<{ entries: ProjectDirEntry[] }>(token, `/api/files/list?dir=${encodeURIComponent(dir)}`),
    resolveResource: (sessionId: string, reference: string) =>
      post<ResourceDescriptor>(token, "/api/resources/resolve", { sessionId, reference }),
    resourceContent: (id: string, sessionId: string, byteLimit?: number) =>
      fetchResourceContent(token, id, sessionId, byteLimit),
    respondExtensionUi: (payload: Record<string, unknown>) =>
      post<{ ok: boolean }>(token, "/api/extension-ui", payload),
    savePreferences: (prefs: InspirePreferences) =>
      request<InspirePreferences>(token, "/api/preferences", { method: "PUT", body: JSON.stringify(prefs) }),
  };
}

export type Api = ReturnType<typeof createApi>;

export function eventsUrl(token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/events?token=${encodeURIComponent(token)}`;
}
