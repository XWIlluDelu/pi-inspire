/** Durable browser authority is an origin-stored, non-extractable signing key.
 * Certificates are public. API bearers exist only in this module's memory. */
interface BrowserIdentity {
  privateKey: CryptoKey;
  certificate: string;
}
interface Access {
  bearer: string;
  expiresAt: number;
}

export class BrowserPairingError extends Error {
  readonly status = 401;
}

let bootstrap: string | null = null;
let access: Access | null = null;
let renewal: Promise<Access> | null = null;
const DATABASE = "inspire-browser-auth";

export function captureBrowserBootstrap(): void {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  bootstrap = fragment.get("inspire-bootstrap");
  // Never authenticate a query token in the bundle (including through HTTPS).
  if (bootstrap || url.searchParams.has("token")) {
    url.searchParams.delete("token");
    if (bootstrap) url.hash = "";
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

function requireStorage(): void {
  if (
    !window.isSecureContext ||
    !globalThis.crypto?.subtle ||
    !globalThis.indexedDB
  )
    throw new BrowserPairingError(
      "Pairing requires WebCrypto and origin storage. Use HTTPS (or a loopback address) in a browser that allows IndexedDB.",
    );
}

async function identityStorage(
  value?: BrowserIdentity,
): Promise<BrowserIdentity | undefined> {
  requireStorage();
  try {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Origin storage is blocked"));
    });
    try {
      return await new Promise<BrowserIdentity | undefined>(
        (resolve, reject) => {
          const transaction = database.transaction(
            "identity",
            value ? "readwrite" : "readonly",
          );
          const request = value
            ? transaction.objectStore("identity").put(value, "host")
            : transaction.objectStore("identity").get("host");
          transaction.oncomplete = () =>
            resolve(value ?? (request.result as BrowserIdentity | undefined));
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        },
      );
    } finally {
      database.close();
    }
  } catch {
    throw new BrowserPairingError(
      "This browser cannot store its pairing key. Allow origin storage (IndexedDB), then pair again.",
    );
  }
}

async function authPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (response.status === 401)
      throw new BrowserPairingError(
        problem?.error ?? "Pair this browser again",
      );
    throw new Error(
      problem?.error ?? `Browser authentication failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

export async function pairBrowser(token?: string): Promise<void> {
  requireStorage();
  access = null;
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const code = bootstrap;
  bootstrap = null;
  const { certificate } = await authPost<{ certificate: string }>(
    "/api/auth/pair",
    {
      ...(token ? { token } : { bootstrap: code }),
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    },
  );
  await identityStorage({ privateKey: keys.privateKey, certificate });
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function renew(): Promise<Access> {
  if (bootstrap) await pairBrowser();
  const identity = await identityStorage();
  if (!identity && import.meta.env.DEV) {
    await pairBrowser("inspire-dev-token");
    return renew();
  }
  if (
    !identity ||
    !(identity.privateKey instanceof CryptoKey) ||
    identity.privateKey.extractable ||
    identity.privateKey.type !== "private"
  )
    throw new BrowserPairingError("Pair this browser to the Host");
  const { challenge } = await authPost<{ challenge: string }>(
    "/api/auth/challenge",
    {
      certificate: identity.certificate,
    },
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.privateKey,
    new TextEncoder().encode(challenge),
  );
  return authPost<Access>("/api/auth/exchange", {
    challenge,
    signature: base64url(signature),
  });
}

export async function browserAuthorization(): Promise<Record<string, string>> {
  if (!access || access.expiresAt <= Date.now() + 30_000) {
    renewal ??= renew().finally(() => {
      renewal = null;
    });
    access = await renewal;
  }
  return { Authorization: `Bearer ${access.bearer}` };
}

/** Refresh before dispatch, never replay after a 401 or an uncertain outcome.
 * Explicit headers are reserved for trusted programmatic clients. */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  transport: typeof fetch = fetch,
): Promise<Response> {
  const target = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    window.location.href,
  );
  if (
    target.origin !== window.location.origin ||
    target.username ||
    target.password
  )
    throw new Error("Refusing to send Host credentials outside this origin");
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (!headers.has("Authorization")) {
    const authorization = await browserAuthorization();
    for (const [name, value] of Object.entries(authorization))
      headers.set(name, value);
  }
  if (init.signal?.aborted) throw init.signal.reason;
  const response = await transport(input, {
    ...init,
    credentials: "omit",
    redirect: "error",
    headers,
  });
  if (response.status === 401) access = null;
  return response;
}

export async function socketTicket(
  audience: "events" | "terminal",
): Promise<string> {
  const response = await authenticatedFetch("/api/auth/socket-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audience }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new BrowserPairingError("Pair this browser again");
    throw new Error("The Host could not authorize the connection");
  }
  return ((await response.json()) as { ticket: string }).ticket;
}
