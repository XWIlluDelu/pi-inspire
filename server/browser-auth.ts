import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { z } from "zod";
import { requestError } from "./request-error.js";

export const BROWSER_ACCESS_TTL_MS = 5 * 60_000;
export const AUTH_CHALLENGE_TTL_MS = 30_000;
export const BROWSER_TICKET_TTL_MS = 15_000;
const MAX_PENDING = 1_024;
const publicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const certificateSchema = z
  .object({
    origin: z.string().max(512),
    publicKey: publicKeySchema,
  })
  .strict();
const accessSchema = z
  .object({
    origin: z.string().max(512),
    expiresAt: z.number().int(),
    nonce: z.string(),
    browserId: z.string().optional(),
  })
  .strict();
export const registrationSchema = z
  .object({
    token: z.string().min(1).max(2_048).optional(),
    bootstrap: z.string().max(128).optional(),
    publicKey: publicKeySchema,
  })
  .strict();
export const challengeSchema = z
  .object({
    certificate: z.string().max(2_048),
  })
  .strict();
export const exchangeSchema = z
  .object({
    challenge: z.string().max(1_024),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export const socketTicketSchema = z
  .object({
    audience: z.enum(["events", "terminal"]),
  })
  .strict();

export function canonicalOrigin(
  host: string | undefined,
  secure: boolean,
): string {
  if (!host) throw requestError("A Host header is required", 400);
  try {
    const url = new URL(`${secure ? "https" : "http"}://${host}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Host");
    return url.origin;
  } catch {
    throw requestError("Host header is not valid", 400);
  }
}

/** WebKit native downloads may omit Origin and Fetch Metadata. Only a strict
 * same-origin Referer can fill that absence; it never overrides a conflicting
 * Origin or Fetch Metadata value. No credential/cookie fallback is admitted. */
export function downloadOriginAllowed(
  expected: string,
  headers: { origin?: string; fetchSite?: string; referer?: string },
): boolean {
  if (headers.origin !== undefined && headers.origin !== expected) return false;
  if (headers.fetchSite !== undefined && headers.fetchSite !== "same-origin")
    return false;
  let referred = false;
  if (headers.referer !== undefined) {
    try {
      const url = new URL(headers.referer);
      if (url.origin !== expected || url.username || url.password) return false;
      referred = true;
    } catch {
      return false;
    }
  }
  return (
    headers.origin === expected ||
    headers.fetchSite === "same-origin" ||
    referred
  );
}

export function secretMatches(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Certificates are public, origin-bound key registrations, not credentials.
 * Domain-separated MACs invalidate all registrations/access on master rotation.
 * Only challenges, launch transfers and socket tickets need process state. */
export class BrowserAuth {
  private readonly challenges = new Map<
    string,
    {
      origin: string;
      publicKey: z.infer<typeof publicKeySchema>;
      expiresAt: number;
    }
  >();
  private readonly tickets = new Map<
    string,
    {
      origin: string;
      audience: "events" | "terminal";
      browserId?: string;
      expiresAt: number;
    }
  >();
  private readonly bootstraps = new Map<
    string,
    { origin: string; expiresAt: number }
  >();
  private readonly downloads = new Map<
    string,
    {
      origin: string;
      resourceId: string;
      sessionId: string;
      expiresAt: number;
    }
  >();

  constructor(
    private readonly master: string,
    private readonly now = Date.now,
  ) {}

  private mac(kind: string, payload: string): string {
    return createHmac("sha256", this.master)
      .update(`inspire-browser-${kind}-v1\n${payload}`)
      .digest("base64url");
  }

  private seal(kind: string, data: unknown): string {
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `ib1.${kind}.${body}.${this.mac(kind, body)}`;
  }

  private unseal(kind: string, value: string): unknown {
    if (value.length > 2_048)
      throw requestError("Pair this browser again", 401);
    const [version, type, body, signature, extra] = value.split(".");
    if (
      version !== "ib1" ||
      type !== kind ||
      !body ||
      !signature ||
      extra !== undefined ||
      !secretMatches(signature, this.mac(kind, body))
    )
      throw requestError("Pair this browser again", 401);
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw requestError("Pair this browser again", 401);
    }
  }

  private admit<T extends { expiresAt: number }>(
    entries: Map<string, T>,
  ): void {
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= this.now()) entries.delete(id);
    }
    if (entries.size >= MAX_PENDING)
      throw requestError(
        "Too many pending authentication requests. Try again shortly.",
        503,
      );
  }

  bootstrap(origin: string): string {
    this.admit(this.bootstraps);
    const code = randomBytes(32).toString("base64url");
    this.bootstraps.set(code, {
      origin,
      expiresAt: this.now() + AUTH_CHALLENGE_TTL_MS,
    });
    return code;
  }

  register(
    origin: string,
    body: z.infer<typeof registrationSchema>,
  ): { certificate: string } {
    let authorized = secretMatches(body.token, this.master);
    if (body.bootstrap) {
      const grant = this.bootstraps.get(body.bootstrap);
      this.bootstraps.delete(body.bootstrap);
      authorized = Boolean(
        grant && grant.origin === origin && grant.expiresAt > this.now(),
      );
    }
    if (!authorized) throw requestError("Access token is not valid", 401);
    // Import validates that x/y form a real point on P-256. Private JWK fields
    // and alternate curves/algorithms are rejected by the strict wire schema.
    try {
      createPublicKey({ key: body.publicKey, format: "jwk" });
    } catch {
      throw requestError("Browser public key is not valid", 400);
    }
    return {
      certificate: this.seal("certificate", {
        origin,
        publicKey: body.publicKey,
      }),
    };
  }

  challenge(
    origin: string,
    certificate: string,
  ): { challenge: string; expiresAt: number } {
    const data = certificateSchema.safeParse(
      this.unseal("certificate", certificate),
    );
    if (!data.success || data.data.origin !== origin)
      throw requestError("Pair this browser again", 401);
    this.admit(this.challenges);
    const challenge = `inspire-browser-auth-v1\n${randomBytes(32).toString("base64url")}\n${origin}\n${createHash("sha256").update(certificate).digest("base64url")}`;
    const expiresAt = this.now() + AUTH_CHALLENGE_TTL_MS;
    this.challenges.set(challenge, { ...data.data, expiresAt });
    return { challenge, expiresAt };
  }

  exchange(
    origin: string,
    challenge: string,
    signature: string,
  ): { bearer: string; expiresAt: number } {
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!entry || entry.expiresAt <= this.now() || entry.origin !== origin)
      throw requestError(
        "Browser authentication challenge expired. Try again.",
        401,
      );
    let valid = false;
    try {
      valid = verify(
        "sha256",
        Buffer.from(challenge),
        {
          key: createPublicKey({ key: entry.publicKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      );
    } catch {
      /* Invalid signatures never authorize. */
    }
    if (!valid)
      throw requestError("Browser authentication signature is not valid", 401);
    const expiresAt = this.now() + BROWSER_ACCESS_TTL_MS;
    return {
      bearer: this.seal("access", {
        origin,
        expiresAt,
        nonce: randomBytes(16).toString("base64url"),
        browserId: this.mac(
          "installation",
          `${origin}\n${entry.publicKey.x}\n${entry.publicKey.y}`,
        ),
      }),
      expiresAt,
    };
  }

  accepts(bearer: string | undefined, origin: string): boolean {
    if (!bearer) return false;
    try {
      const data = accessSchema.safeParse(this.unseal("access", bearer));
      return (
        data.success &&
        data.data.origin === origin &&
        data.data.expiresAt > this.now() &&
        data.data.expiresAt <= this.now() + BROWSER_ACCESS_TTL_MS
      );
    } catch {
      return false;
    }
  }

  installation(
    bearer: string | undefined,
    origin: string,
  ): { id: string; origin: string } | null {
    if (!this.accepts(bearer, origin)) return null;
    const data = accessSchema.parse(this.unseal("access", bearer!));
    return data.browserId ? { id: data.browserId, origin } : null;
  }

  notificationNamespace(): string {
    return this.mac("notification-store", "").slice(0, 22);
  }

  ticket(
    origin: string,
    audience: "events" | "terminal",
    browserId?: string,
  ): { ticket: string; expiresAt: number } {
    this.admit(this.tickets);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + BROWSER_TICKET_TTL_MS;
    this.tickets.set(ticket, { origin, audience, expiresAt, browserId });
    return { ticket, expiresAt };
  }

  downloadTicket(
    origin: string,
    resourceId: string,
    sessionId: string,
  ): { ticket: string; expiresAt: number } {
    this.admit(this.downloads);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + BROWSER_TICKET_TTL_MS;
    this.downloads.set(ticket, { origin, resourceId, sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  consumeDownload(
    ticket: string,
    origin: string,
  ): { resourceId: string; sessionId: string } {
    const grant = this.downloads.get(ticket);
    this.downloads.delete(ticket);
    if (!grant || grant.origin !== origin || grant.expiresAt <= this.now())
      throw requestError(
        "This download expired. Download the file again.",
        401,
      );
    return { resourceId: grant.resourceId, sessionId: grant.sessionId };
  }

  consumeTicket(
    ticket: string | null,
    origin: string,
    audience: string,
  ): boolean {
    return this.consumeTicketGrant(ticket, origin, audience) !== null;
  }

  consumeTicketGrant(
    ticket: string | null,
    origin: string,
    audience: string,
  ): { origin: string; browserId?: string } | null {
    if (!ticket) return null;
    const grant = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return grant &&
      grant.origin === origin &&
      grant.audience === audience &&
      grant.expiresAt > this.now()
      ? grant
      : null;
  }
}
