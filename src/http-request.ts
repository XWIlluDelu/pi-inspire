import type { UploadedAttachment } from "../shared/contracts";
import {
  type HostOperationCommand,
  matchOperationReceipt,
} from "../shared/host-operations";
import { isJsonRecord } from "../shared/json-record";
import {
  authenticatedFetch,
  BrowserPairingError,
  BrowserUpgradeRequired,
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

// Leave room for the Host's 30-second Pi reads and response transfer.
export const HTTP_OBSERVATION_TIMEOUT_MS = 45_000;

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

export function aborted(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AbortError",
  );
}

export async function applicationFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  transport?: typeof fetch,
): Promise<Response> {
  try {
    return await authenticatedFetch(input, init, transport);
  } catch (error) {
    if (aborted(error) || error instanceof BrowserUpgradeRequired) throw error;
    if (error instanceof BrowserPairingError)
      throw new ApiError(401, error.message);
    throw new ApiTransportError("request");
  }
}

export async function responseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (aborted(error)) throw error;
    throw new ApiTransportError("response");
  }
}

function httpError(
  response: Response,
  body: Record<string, unknown> | null,
  operation = false,
): ApiError {
  return new ApiError(
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

async function errorBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const decoded: unknown = await response.json();
    return isJsonRecord(decoded) ? decoded : null;
  } catch (error) {
    if (aborted(error)) throw error;
    if (!(error instanceof SyntaxError)) throw new ApiTransportError("response");
    return null;
  }
}

export async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) throw httpError(response, await errorBody(response));
}

/** Cancellation retires an observer, not a Host operation. Keep it distinct
 * from a failed transport, even when the abandoned write may have committed. */
export class ApiRequestCancelledError extends Error {
  constructor(public outcomeUnknown: boolean) {
    super("Request observation cancelled");
    this.name = "AbortError";
  }
}

export interface ObservationOptions {
  /** null keeps Pi-owned long operations completion-driven. */
  timeoutMs?: number | null;
  matchReceipt?: Parameters<typeof matchOperationReceipt>[1];
  mutation?: boolean;
}

export async function observeRequest<T>(
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

export async function request<T>(
  path: string,
  init: RequestInit = {},
  options: ObservationOptions = {},
  transport?: typeof fetch,
): Promise<T> {
  return observeRequest(
    init.signal,
    { mutation: Boolean(init.method && init.method !== "GET"), ...options },
    async (signal) => {
      const headers = new Headers(init.headers);
      if (init.body !== undefined && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      const response = await applicationFetch(
        path, { ...init, signal, headers }, transport,
      );
      const identity = options.matchReceipt;
      if (!identity) {
        await ensureOk(response);
        return response.status === 204
          ? (undefined as T)
          : responseJson<T>(response);
      }
      const value = response.ok
        ? await responseJson<unknown>(response)
        : await errorBody(response);
      if (!response.ok && (!isJsonRecord(value) || !("executor" in value)))
        throw httpError(response, isJsonRecord(value) ? value : null, true);
      const receipt = matchOperationReceipt(value, identity, response.status);
      if (!receipt) throw new ApiTransportError("response", true);
      return receipt as T;
    },
  );
}
