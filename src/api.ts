import type {
  BranchImageRequest,
  CompletionAttentionPreference,
  PendingOperationRequest,
  PendingRecovery,
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  SessionHistoryPages,
  UploadedAttachment,
} from "../shared/contracts";
import type { SessionHistoryQuery } from "../shared/history-query";
import { hostEndpoints as routes } from "../shared/host-endpoints";
import {
  type HostOperationCommand,
  type HostOperationIdentity,
  type HostOperationReceipt,
  hostReceipt,
  inputOperationEndpoints as inputRoutes,
  matchOperationReceipt,
} from "../shared/host-operations";
import {
  type HostRestartOperation,
  type HostRestartRequest,
  matchesRestartIntent,
  restartReceiptIdentity,
} from "../shared/host-restart";
import type {
  JsonEndpoint,
  RequestInput,
  RequestSchemas,
} from "../shared/json-endpoints";
import { isJsonRecord } from "../shared/json-record";
import type { ModelSettingsOwner } from "../shared/model-settings";
import type { TaskNotificationGrouping } from "../shared/notifications";
import type { ProviderAuthOperation } from "../shared/provider-auth-bridge";
import { terminalOperations } from "./controllers/terminal-operation-controller";
import { withTransportMeasure } from "./transport-performance";

export type {
  ProjectFileResult,
  ProjectFileSearchResult,
} from "../shared/host-endpoints";

import {
  authenticatedFetch,
  BrowserPairingError,
  BrowserUpgradeRequired,
  browserBuildId,
} from "./browser-auth";

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
    public operation?: { operationId: string; command: HostOperationCommand },
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
    if (aborted(error) || error instanceof BrowserUpgradeRequired) throw error;
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

async function ensureOk(
  response: Response,
  operation = false,
): Promise<unknown> {
  if (response.ok) return;
  let body: Record<string, unknown> | null = null;
  try {
    const decoded: unknown = await response.json();
    if (isJsonRecord(decoded)) body = decoded;
  } catch (error) {
    if (aborted(error)) throw error;
    if (!(error instanceof SyntaxError))
      throw new ApiTransportError("response");
  }
  // An admitted operation may report its result through a non-2xx HTTP status.
  // The caller still has to validate the complete receipt and its identity.
  if (operation && body && "executor" in body) return body;
  throw new ApiError(
    response.status,
    typeof body?.error === "string"
      ? body.error
      : `Request failed (${response.status})`,
    Array.isArray(body?.matches) ? body.matches.map(String) : undefined,
    typeof body?.code === "string" ? body.code : undefined,
    response.headers.get("X-Inspire-Edge") ?? undefined,
    undefined,
    operation || body?.outcomeUnknown === true,
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
  readErrorBody?: boolean;
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
      if (!response.ok)
        return (await ensureOk(response, options.readErrorBody)) as T;
      return response.status === 204
        ? (undefined as T)
        : responseJson<T>(response);
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

function readBlob(
  path: string,
  options: { signal?: AbortSignal; headers?: HeadersInit; timeoutMs?: number },
): Promise<{ blob: Blob; response: Response }> {
  const { signal, headers, timeoutMs } = options;
  return observeRequest(signal, { timeoutMs }, async (signal) => {
    const response = await applicationFetch(path, { signal, headers });
    await ensureOk(response);
    try {
      return { blob: await response.blob(), response };
    } catch (error) {
      if (aborted(error)) throw error;
      throw new ApiTransportError("response");
    }
  });
}

async function fetchResourceContent(
  id: string,
  sessionId: string,
  options: ResourceContentOptions = {},
): Promise<ResourceContentResponse> {
  const { byteLimit, signal } = options;
  const { blob, response } = await readBlob(
    `/api/resources/${encodeURIComponent(id)}/content?sessionId=${encodeURIComponent(sessionId)}`,
    {
      signal,
      timeoutMs: transferObservationTimeout(byteLimit ?? 0),
      headers: byteLimit
        ? { Range: `bytes=0-${Math.max(0, byteLimit - 1)}` }
        : undefined,
    },
  );
  if (byteLimit !== undefined && blob.size > byteLimit)
    throw new ApiError(502, "The resource response exceeded its byte limit");
  return { blob, totalSize: contentTotalSize(response, blob) };
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
            call(routes.deleteAttachment, { params: { id: item.id } }).catch(
              () => undefined,
            ),
          ),
        );
      return result;
    },
  );
}

function confirmedHostReceipt<Command extends HostOperationCommand>(
  command: Command,
  identity: HostOperationIdentity,
  value: unknown,
): Extract<HostOperationReceipt<Command>, { state: "pending" | "completed" }> {
  const receipt = matchOperationReceipt(value, hostReceipt(command, identity));
  if (!receipt) throw new ApiTransportError("response", true);
  if (receipt.state === "pending")
    return receipt as HostOperationReceipt<Command> & { state: "pending" };
  if (receipt.state === "completed") {
    const result = receipt.result;
    const valid =
      command === "prompt"
        ? result === null ||
          (isJsonRecord(result) && typeof result.text === "string")
        : isJsonRecord(result) &&
          Array.isArray(result.steering) &&
          Array.isArray(result.followUp);
    if (valid)
      return receipt as HostOperationReceipt<Command> & { state: "completed" };
  }
  if (receipt.state === "unknown" || receipt.state === "rejected") {
    const detail = receipt.error;
    throw new ApiError(
      detail.status,
      detail.message,
      Array.isArray(detail.matches) ? detail.matches.map(String) : undefined,
      typeof detail.code === "string" ? detail.code : undefined,
      undefined,
      identity.authorityId,
      receipt.state === "unknown",
      { operationId: identity.operationId, command },
      Array.isArray(detail.recoveredAttachments)
        ? (detail.recoveredAttachments as UploadedAttachment[])
        : undefined,
      typeof detail.recoveryId === "string" ? detail.recoveryId : undefined,
    );
  }
  throw new ApiTransportError("response", true);
}

async function pendingHandoff(
  { action, operationId, ...query }: PendingOperationRequest,
  phase: "start" | "observe" = "observe",
): Promise<PendingRecovery> {
  const options = { mutation: true, readErrorBody: true };
  const value =
    phase === "start"
      ? await call(
          inputRoutes[action],
          { body: { operationId, ...query } },
          undefined,
          options,
        )
      : await call(
          inputRoutes.observePending,
          { params: { operationId }, query: { action, ...query } },
          undefined,
          options,
        );
  const receipt = confirmedHostReceipt(
    action,
    { operationId, authorityId: query.authorityId },
    value,
  );
  if (receipt.state !== "completed")
    throw new ApiTransportError("response", true);
  return receipt.result;
}

function waitForPromptPoll(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      if (signal?.aborted) reject(new ApiRequestCancelledError(true));
      else resolve();
    };
    const timer = window.setTimeout(finish, delay);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

async function deliverPrompt(
  identity: HostOperationIdentity & { fingerprint?: string },
  signal?: AbortSignal,
  body?: PromptDeliveryRequest,
): Promise<PromptAcceptedResponse> {
  const { operationId, authorityId, fingerprint } = identity;
  const observation = {
    params: { operationId },
    query: { authorityId, fingerprint: fingerprint || undefined },
  };
  const options = {
    mutation: true,
    readErrorBody: true,
    timeoutMs: PROMPT_CONFIRMATION_TIMEOUT_MS,
  };
  let failures = 0;
  const retryDelays = [250, 1_000, 3_000];
  for (;;) {
    let delay: number;
    try {
      const value =
        body === undefined
          ? await call(inputRoutes.observePrompt, observation, signal, options)
          : await call(inputRoutes.prompt, { body }, signal, options);
      const receipt = confirmedHostReceipt("prompt", identity, value);
      if (receipt.state === "completed")
        return { accepted: true, historyEntry: receipt.result };
      failures = 0;
      delay = 250;
    } catch (error) {
      if (
        error instanceof ApiError
          ? error.operation ||
            (error.status < 500 && error.status !== 408 && error.status !== 429)
          : !(error instanceof ApiTransportError) || error.phase === "response"
      )
        throw error;
      const retry = retryDelays[failures++];
      if (retry === undefined || signal?.aborted) throw error;
      delay = retry;
    }
    body = undefined;
    await waitForPromptPoll(delay, signal);
  }
}

function call<S extends RequestSchemas, T>(
  route: JsonEndpoint<S, T>,
  input: RequestInput<NoInfer<S>>,
  signal?: AbortSignal,
  options?: ObservationOptions,
): Promise<T> {
  const { params, query, body } = input as {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  };
  let path: string = route.path;
  if (params)
    path = path.replace(/:(\w+)/g, (_match, key: string) =>
      encodeURIComponent(params[key]!),
    );
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) search.set(key, String(value));
    if (search.size) path += `?${search}`;
  }
  return request<T>(
    path,
    {
      ...(route.method !== "get" ? { method: route.method.toUpperCase() } : {}),
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      mutation: route.mutation ?? route.method !== "get",
      timeoutMs: route.timeoutMs,
      ...options,
    },
  );
}

function flag(value: boolean | undefined) {
  return value ? "1" : undefined;
}

type HostEndpoint = typeof routes;
type EndpointResult<E> =
  E extends JsonEndpoint<infer _Schemas, infer Result> ? Result : never;

function hostJson<K extends keyof HostEndpoint>(
  name: K,
  input: RequestInput<HostEndpoint[K]["schemas"]>,
  signal?: AbortSignal,
): Promise<EndpointResult<HostEndpoint[K]>> {
  const route = routes[name] as JsonEndpoint<
    HostEndpoint[K]["schemas"],
    EndpointResult<HostEndpoint[K]>
  >;
  return call(route, input, signal);
}

export function createApi() {
  return {
    json: hostJson,
    taskAlertSettings: () => call(routes.taskAlertSettings, {}),
    configureTaskAlerts: (
      mode: CompletionAttentionPreference | undefined,
      subscription?: PushSubscriptionJSON | null,
      grouping?: TaskNotificationGrouping,
    ) =>
      call(routes.configureTaskAlerts, {
        body: {
          mode,
          grouping,
          subscription: subscription
            ? {
                endpoint: subscription.endpoint!,
                keys: subscription.keys as { p256dh: string; auth: string },
              }
            : subscription,
        },
      }),
    acknowledgeTaskAlert: (id: string) =>
      call(routes.acknowledgeTaskAlert, { body: { id } }),
    testTaskAlert: () => call(routes.testTaskAlert, {}),
    hostRestartStatus: () => call(routes.hostRestartStatus, {}),
    restartHost: async (intent: HostRestartRequest) => {
      const value = await call(routes.restartHost, { body: intent });
      const receipt = matchOperationReceipt(
        value,
        restartReceiptIdentity(intent),
      );
      const result = receipt?.result;
      if (
        !isJsonRecord(result) ||
        !matchesRestartIntent(result, intent) ||
        !["preparing", "submitted", "unknown", "rejected"].includes(
          String(result.phase),
        ) ||
        receipt?.state !==
          (result.phase === "submitted" || result.phase === "preparing"
            ? "pending"
            : result.phase)
      )
        throw new ApiTransportError("response", true);
      return result as unknown as HostRestartOperation;
    },
    bootstrap: (signal?: AbortSignal) =>
      withTransportMeasure("bootstrap-metadata", () =>
        call(routes.bootstrap, {}, signal),
      ),
    snapshot: (sessionId: string | null) =>
      call(routes.snapshot, {
        query: { detail: sessionId === null ? "" : sessionId },
      }),
    sessionHistory: <Q extends SessionHistoryQuery>(
      sessionId: string,
      viewId: string,
      query: Q,
      signal?: AbortSignal,
    ) =>
      call(
        routes.sessionHistory,
        { query: { ...query, sessionId, viewId } },
        signal,
      ) as Promise<SessionHistoryPages[Q["kind"]]>,
    branchImage: async (
      body: BranchImageRequest,
      index: number,
      signal?: AbortSignal,
    ) =>
      (
        await readBlob(
          `/api/branches/image?${new URLSearchParams({
            sessionId: body.sessionId,
            viewId: body.viewId,
            targetId: body.targetId,
            index: String(index),
          })}`,
          { signal },
        )
      ).blob,
    sessions: (q: string, offset = 0, limit = 40, signal?: AbortSignal) =>
      call(routes.sessions, { query: { q, offset, limit } }, signal),
    sessionsByIds: (ids: string[], signal?: AbortSignal) =>
      call(routes.sessionsByIds, { body: { ids } }, signal),
    sessionsByCwds: (cwds: string[], signal?: AbortSignal) =>
      call(routes.sessionsByCwds, { body: { cwds } }, signal),
    refreshModels: (
      sessionId?: string,
      cwd?: string,
      inherit = false,
      signal?: AbortSignal,
    ) =>
      call(
        routes.refreshModels,
        {
          query: {
            sessionId: sessionId || undefined,
            cwd: cwd || undefined,
            inherit: inherit ? "1" : undefined,
          },
        },
        signal,
      ),
    providerAuth: (query: ModelSettingsOwner, body: ProviderAuthOperation) =>
      call(routes.providerAuth, { query, body }, undefined, {
        mutation: body.operation !== "providers" && body.operation !== "status",
      }),
    searchNewSessionFiles: (
      cwd: string,
      q: string,
      limit = 50,
      showHidden = false,
    ) =>
      call(routes.searchNewSessionFiles, {
        query: { cwd, q, limit, showHidden: flag(showHidden) },
      }),
    terminals: (cwd?: string) =>
      call(routes.terminals, { query: { cwd: cwd || undefined } }),
    retryTerminalOperation: (key: string) => terminalOperations.retry(key),
    terminalOperation: terminalOperations.run.bind(terminalOperations),
    terminalAttachTicket: (id: string, signal?: AbortSignal) =>
      call(routes.terminalAttachTicket, { params: { id } }, signal),
    terminalSettings: () => call(routes.terminalSettings, {}),
    prompt: (
      body: PromptDeliveryRequest,
      signal?: AbortSignal,
      fingerprint?: string,
    ) =>
      withTransportMeasure("prompt-confirmation", () =>
        deliverPrompt({ ...body, fingerprint }, signal, body),
      ),
    observePrompt: (
      identity: HostOperationIdentity & { fingerprint?: string },
      signal?: AbortSignal,
    ) => deliverPrompt(identity, signal),
    exportDownload: async (sessionId: string, id: string) =>
      (
        await readBlob(
          `/api/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(id)}`,
          { timeoutMs: LONG_HTTP_OBSERVATION_TIMEOUT_MS },
        )
      ).blob,
    pendingOperation: pendingHandoff,
    uploadAttachments: (files: File[], signal?: AbortSignal) =>
      uploadFiles(files, signal),
    attachmentPreview: async (id: string, signal?: AbortSignal) =>
      (
        await readBlob(`/api/attachments/${encodeURIComponent(id)}/image`, {
          signal,
        })
      ).blob,
    deleteAttachment: (id: string) =>
      call(routes.deleteAttachment, { params: { id } }),
    searchFiles: (
      sessionId: string,
      q: string,
      limit = 50,
      signal?: AbortSignal,
      showHidden = false,
    ) =>
      call(
        routes.searchFiles,
        { query: { sessionId, q, limit, showHidden: flag(showHidden) } },
        signal,
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
      call(
        routes.listFiles,
        {
          query: {
            sessionId,
            dir,
            refresh: flag(options.refresh),
            showHidden: flag(options.showHidden),
          },
        },
        options.signal,
      ),
    gitStatus: (sessionId: string, signal?: AbortSignal) =>
      call(routes.gitStatus, { query: { sessionId } }, signal),
    gitDiff: (sessionId: string, pathId: string, signal?: AbortSignal) =>
      call(routes.gitDiff, { body: { sessionId, pathId } }, signal),
    browseHostRoots: () => call(routes.browseHostRoots, {}),
    browseHostDirs: (path?: string, showHidden = false) =>
      call(routes.browseHostDirs, {
        query: { path: path || undefined, showHidden: flag(showHidden) },
      }),
    listResources: (sessionId: string, signal?: AbortSignal) =>
      call(routes.listResources, { body: { sessionId } }, signal),
    probeResources: (
      sessionId: string,
      references: string[],
      signal?: AbortSignal,
    ) =>
      call(routes.probeResources, { body: { sessionId, references } }, signal),
    resolveResource: (
      sessionId: string,
      reference: string,
      signal?: AbortSignal,
      workspacePath?: string,
    ) =>
      call(
        routes.resolveResource,
        { body: { sessionId, reference, workspacePath } },
        signal,
      ),
    showInFileManager: (
      sessionId: string,
      reference: string,
      workspacePath?: string,
      directory = false,
    ) =>
      call(routes.showInFileManager, {
        body: { sessionId, reference, workspacePath, directory },
      }),
    createHtmlPreview: (id: string, sessionId: string, html: string) =>
      call(routes.createHtmlPreview, {
        params: { id },
        body: { sessionId, html },
      }),
    deleteHtmlPreview: (id: string, sessionId: string) =>
      call(routes.deleteHtmlPreview, { params: { id }, query: { sessionId } }),
    resourceDownloadTicket: (
      id: string,
      sessionId: string,
      signal: AbortSignal,
    ) =>
      call(
        routes.resourceDownloadTicket,
        { params: { id }, body: { sessionId } },
        signal,
      ),
    resourceContent: (
      id: string,
      sessionId: string,
      options?: ResourceContentOptions,
    ) => fetchResourceContent(id, sessionId, options),
  };
}

export type Api = ReturnType<typeof createApi>;

export function terminalUrl(ticket: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal?${new URLSearchParams({ ticket, build: browserBuildId() })}`;
}

export function eventsUrl(ticket: string, sessionId: string | null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ ticket, build: browserBuildId() });
  query.set("detail", sessionId ?? "");
  return `${protocol}//${window.location.host}/events?${query}`;
}
