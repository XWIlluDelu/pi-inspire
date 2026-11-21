import { base64url } from "./base64url";

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

export class BrowserPairingError extends Error {}

type BrowserPairingMode = "persistent" | "session" | "none";

let bootstrap: string | null = null;
let access: Access | null = null;
let renewal: Promise<Access> | null = null;
let ephemeralIdentity: BrowserIdentity | null = null;
let pairingMode: BrowserPairingMode = "none";
const DATABASE = "inspire-browser-auth";

export function getBrowserPairingMode(): BrowserPairingMode {
  return pairingMode;
}

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

function requireCrypto(): void {
  if (!window.isSecureContext || !globalThis.crypto?.subtle)
    throw new BrowserPairingError(
      "Pairing requires WebCrypto. Use HTTPS or a loopback address.",
    );
}

function requireStorage(): void {
  requireCrypto();
  if (!globalThis.indexedDB)
    throw new BrowserPairingError(
      "Saving pairing requires origin storage (IndexedDB). Use a temporary session or allow origin storage.",
    );
}

async function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Origin storage is blocked"));
  });
}

async function identityStorage(
  value?: BrowserIdentity | null,
): Promise<BrowserIdentity | undefined> {
  requireStorage();
  try {
    const database = await openIdentityDatabase();
    try {
      return await new Promise<BrowserIdentity | undefined>(
        (resolve, reject) => {
          const transaction = database.transaction(
            "identity",
            value !== undefined ? "readwrite" : "readonly",
          );
          const store = transaction.objectStore("identity");
          const request =
            value === null
              ? store.delete("host")
              : value
                ? store.put(value, "host")
                : store.get("host");
          transaction.oncomplete = () =>
            resolve(
              value === null
                ? undefined
                : (value ?? (request.result as BrowserIdentity | undefined)),
            );
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        },
      );
    } finally {
      database.close();
    }
  } catch {
    throw new BrowserPairingError(
      "This browser cannot store its pairing key. Allow origin storage (IndexedDB) or sign in for this session only.",
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

export async function pairBrowser(
  token?: string,
  options: { persist?: boolean } = {},
): Promise<void> {
  const persist = options.persist !== false;
  if (persist) requireStorage();
  else requireCrypto();
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
  const identity: BrowserIdentity = {
    privateKey: keys.privateKey,
    certificate,
  };
  if (persist) {
    ephemeralIdentity = null;
    await identityStorage(identity);
    pairingMode = "persistent";
  } else {
    ephemeralIdentity = identity;
    pairingMode = "session";
    // Clear any prior saved pairing so switching to a one-time session leaves no key behind.
    await identityStorage(null).catch(() => undefined);
  }
}

export async function clearBrowserPairing(): Promise<void> {
  bootstrap = null;
  access = null;
  renewal = null;
  ephemeralIdentity = null;
  pairingMode = "none";
  await identityStorage(null).catch(() => undefined);
}

function signingIdentity(
  identity: BrowserIdentity | null | undefined,
): identity is BrowserIdentity {
  return Boolean(
    identity &&
      typeof identity.certificate === "string" &&
      identity.privateKey instanceof CryptoKey &&
      !identity.privateKey.extractable &&
      identity.privateKey.type === "private",
  );
}

async function exchange(identity: BrowserIdentity): Promise<Access> {
  const { challenge } = await authPost<{ challenge: string }>(
    "/api/auth/challenge",
    { certificate: identity.certificate },
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

async function renew(): Promise<Access> {
  if (signingIdentity(ephemeralIdentity)) {
    pairingMode = "session";
    return exchange(ephemeralIdentity);
  }
  let identity = await identityStorage();
  if (bootstrap) {
    if (signingIdentity(identity)) {
      try {
        const result = await exchange(identity);
        // A spent/expired launch link cannot invalidate a valid stored pairing.
        bootstrap = null;
        pairingMode = "persistent";
        return result;
      } catch (error) {
        if (!(error instanceof BrowserPairingError)) throw error;
      }
    }
    // A fresh launch can repair a missing pairing or a rotated Host authority.
    await pairBrowser();
    identity = await identityStorage();
  }
  if (!identity && import.meta.env.DEV) {
    await pairBrowser("inspire-dev-token");
    return renew();
  }
  if (!signingIdentity(identity)) {
    pairingMode = "none";
    throw new BrowserPairingError("Pair this browser to the Host");
  }
  pairingMode = "persistent";
  return exchange(identity);
}

async function browserBearer(): Promise<string> {
  if (!access || access.expiresAt <= Date.now() + 30_000) {
    renewal ??= renew().finally(() => {
      renewal = null;
    });
    access = await renewal;
  }
  return access.bearer;
}

/** Refresh before dispatch, never replay after a 401 or an uncertain outcome. */
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
  if (init.signal?.aborted) throw init.signal.reason;
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("Authorization", `Bearer ${await browserBearer()}`);
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
  signal = AbortSignal.timeout(10_000),
): Promise<string> {
  const response = await authenticatedFetch("/api/auth/socket-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audience }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new BrowserPairingError("Pair this browser again");
    throw new Error("The Host could not authorize the connection");
  }
  return ((await response.json()) as { ticket: string }).ticket;
}
