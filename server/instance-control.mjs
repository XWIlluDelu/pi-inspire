import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DOMAIN = "inspire:local-http-control:v1";
const TTL_MS = 15_000;
const MAX_BYTES = 2_048;
const MAX_PENDING = 1_024;
const actions = new Set([
  "readiness",
  "launch-url",
  "maintenance-prepare",
  "maintenance-commit",
  "maintenance-release",
]);
const encodedSecret = /^[A-Za-z0-9_-]{43}$/u;

/** The state owner, never a caller-supplied PID/root, supplies this binding.
 * Keep the encoding shared with the existing local shutdown mailbox. */
export function instanceIdentity(state) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        state.schemaVersion,
        state.pid,
        state.processStartTime,
        state.startedAt,
        state.root,
        state.host,
        state.port,
        state.mock,
      ]),
    )
    .digest("base64url");
}

function signature(state, direction, payload) {
  return createHmac("sha256", state.token)
    .update(DOMAIN)
    .update("\0")
    .update(direction)
    .update("\0")
    .update(instanceIdentity(state))
    .update("\0")
    .update(JSON.stringify(payload))
    .digest();
}

function matches(expected, actual) {
  return (
    typeof actual === "string" &&
    encodedSecret.test(actual) &&
    timingSafeEqual(expected, Buffer.from(actual, "base64url"))
  );
}

function requestPayload(value) {
  return {
    version: value.version,
    nonce: value.nonce,
    expiresAt: value.expiresAt,
    action: value.action,
    payload: value.payload,
  };
}

export function createInstanceControlRequest(
  state,
  action,
  payload = {},
  timeoutMs = TTL_MS,
) {
  if (state.httpControlVersion !== 1 || !actions.has(action))
    throw new Error("This Host does not support authenticated local HTTP control");
  const message = {
    version: 1,
    nonce: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + Math.min(timeoutMs, TTL_MS),
    action,
    payload,
  };
  return {
    ...message,
    proof: signature(state, "request", message).toString("base64url"),
  };
}

/** Bounded, process-local one-use requests. Readiness and maintenance have
 * separate actions but identical peer authentication and replay protection. */
export class InstanceHttpControl {
  #seen = new Map();
  #now;

  constructor(now = Date.now) {
    this.#now = now;
  }

  accept(state, value) {
    const now = this.#now();
    if (
      state?.httpControlVersion !== 1 ||
      !value ||
      value.version !== 1 ||
      typeof value.nonce !== "string" ||
      !encodedSecret.test(value.nonce) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + TTL_MS ||
      !actions.has(value.action) ||
      !value.payload ||
      typeof value.payload !== "object" ||
      Array.isArray(value.payload) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES
    )
      return null;
    const payload = requestPayload(value);
    if (!matches(signature(state, "request", payload), value.proof)) return null;
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(nonce);
    }
    if (this.#seen.has(value.nonce) || this.#seen.size >= MAX_PENDING) return null;
    this.#seen.set(value.nonce, value.expiresAt);
    return { state, request: payload };
  }

  reply(grant, result) {
    const payload = { version: 1, nonce: grant.request.nonce, result };
    return {
      ...payload,
      proof: signature(grant.state, "response", payload).toString("base64url"),
    };
  }
}

export function verifyInstanceControlResponse(state, request, value) {
  if (
    !value ||
    value.version !== 1 ||
    value.nonce !== request.nonce ||
    !Object.hasOwn(value, "result")
  )
    return false;
  return matches(
    signature(state, "response", {
      version: 1,
      nonce: value.nonce,
      result: value.result,
    }),
    value.proof,
  );
}

/** A hostile/replaced listener gets a single-action, expiring proof, never the
 * reusable Host key. Never follow redirects or accept an unsigned response. */
export async function requestInstanceControl(
  state,
  action,
  payload = {},
  timeoutMs = 1_500,
) {
  if (state.httpControlVersion !== 1) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const message = createInstanceControlRequest(state, action, payload, timeoutMs);
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > MAX_BYTES) return null;
    const host = state.host === "::1" ? "[::1]" : state.host;
    const response = await fetch(
      `http://${host}:${state.port}/api/host/local-control`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      controller.abort();
      return null;
    }
    if (!response.body) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) {
        controller.abort();
        return null;
      }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      controller.signal.aborted ||
      Date.now() >= message.expiresAt ||
      !verifyInstanceControlResponse(state, message, value)
    )
      return null;
    return value.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
