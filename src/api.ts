import type {
  BranchImageRequest,
  CompletionAttentionPreference,
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
  type PendingOperationRequest,
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
import {
  aborted,
  ApiError,
  ApiRequestCancelledError,
  ApiTransportError,
  applicationFetch,
  ensureOk,
  observeRequest,
  type ObservationOptions,
  request,
  responseJson,
} from "./http-request";
import { withTransportMeasure } from "./transport-performance";

export type {
  ProjectFileResult,
  ProjectFileSearchResult,
} from "../shared/host-endpoints";
export {
  ApiError,
  ApiRequestCancelledError,
  ApiTransportError,
  HTTP_OBSERVATION_TIMEOUT_MS,
} from "./http-request";

const PROMPT_CONFIRMATION_TIMEOUT_MS = 30_000;
const LONG_HTTP_OBSERVATION_TIMEOUT_MS = 120_000;

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

async function readHostReceipt<
  S extends RequestSchemas,
  Command extends HostOperationCommand,
>(
  route: JsonEndpoint<S, HostOperationReceipt<Command>>,
  input: RequestInput<NoInfer<S>>,
  identity: HostOperationIdentity,
  command: Command,
  signal?: AbortSignal,
  timeoutMs = route.timeoutMs,
): Promise<
  Extract<HostOperationReceipt<Command>, { state: "pending" | "completed" }>
> {
  const receipt = await call(route, input, signal, {
    mutation: true,
    matchReceipt: hostReceipt(command, identity),
    timeoutMs,
  });
  if (receipt.state === "pending") return receipt;
  if (receipt.state === "completed") {
    const result = receipt.result;
    if (
      command === "prompt"
        ? result === null
        : isJsonRecord(result) &&
          Array.isArray(result.steering) &&
          Array.isArray(result.followUp)
    )
      return receipt;
  } else {
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
  const identity = { operationId, authorityId: query.authorityId };
  const receipt =
    phase === "start"
      ? await readHostReceipt(
          inputRoutes[action],
          { body: { operationId, ...query } },
          identity,
          action,
        )
      : await readHostReceipt(
          inputRoutes.observePending,
          { params: { operationId }, query: { action, ...query } },
          identity,
          action,
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
  let failures = 0;
  const retryDelays = [250, 1_000, 3_000];
  for (;;) {
    let delay: number;
    try {
      const receipt = body === undefined
        ? await readHostReceipt(
            inputRoutes.observePrompt,
            observation,
            identity,
            "prompt",
            signal,
            PROMPT_CONFIRMATION_TIMEOUT_MS,
          )
        : await readHostReceipt(
            inputRoutes.prompt,
            { body },
            identity,
            "prompt",
            signal,
            PROMPT_CONFIRMATION_TIMEOUT_MS,
          );
      if (receipt.state === "completed")
        return { accepted: true };
      failures = 0;
      delay = 250;
    } catch (error) {
      if (
        error instanceof ApiError
          ? error.operation ||
            (error.status < 500 && error.status !== 408 && error.status !== 429)
          : !(error instanceof ApiTransportError)
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
    providerAuth: (query: ModelSettingsOwner, body: ProviderAuthOperation) =>
      call(routes.providerAuth, { query, body }, undefined, {
        mutation: body.operation !== "providers" && body.operation !== "status",
      }),
    terminalOperation: terminalOperations.run.bind(terminalOperations),
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
  return `${protocol}//${window.location.host}/terminal?${new URLSearchParams({ ticket })}`;
}

export function eventsUrl(ticket: string, sessionId: string | null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ ticket, detail: sessionId ?? "" });
  return `${protocol}//${window.location.host}/events?${query}`;
}
