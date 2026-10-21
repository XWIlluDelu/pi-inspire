import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTH_CHALLENGE_TTL_MS,
  BROWSER_ACCESS_TTL_MS,
  BROWSER_TICKET_TTL_MS,
  BrowserAuth,
  canonicalOrigin,
  registrationSchema,
} from "../../server/browser-auth.js";

const origin = "http://localhost:4587";
const other = "http://localhost:4588";
const master = "isolated-test-master";
function identity() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey: registrationSchema.shape.publicKey.parse({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    }),
  };
}
const signed = (
  key: ReturnType<typeof identity>["privateKey"],
  challenge: string,
) =>
  sign("sha256", Buffer.from(challenge), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

describe("origin-key browser authentication", () => {
  it("registers only with master/bootstrap, authenticates signatures, and separates credential types", () => {
    const auth = new BrowserAuth(master);
    const key = identity();
    const { certificate } = auth.register(origin, {
      token: master,
      publicKey: key.publicKey,
    });
    expect(() =>
      auth.register(origin, { token: certificate, publicKey: key.publicKey }),
    ).toThrow();
    expect(auth.accepts(certificate, origin)).toBe(false);
    expect(auth.accepts(master, origin)).toBe(false);
    const { challenge } = auth.challenge(origin, certificate);
    const access = auth.exchange(
      origin,
      challenge,
      signed(key.privateKey, challenge),
    );
    expect(auth.accepts(access.bearer, origin)).toBe(true);
    expect(auth.accepts(access.bearer, other)).toBe(false);
    expect(() => auth.challenge(origin, access.bearer)).toThrow();
    expect(() =>
      auth.register(origin, { token: access.bearer, publicKey: key.publicKey }),
    ).toThrow();
    expect(() =>
      auth.exchange(origin, challenge, signed(key.privateKey, challenge)),
    ).toThrow();
    expect(() => auth.challenge(other, certificate)).toThrow();
    expect(() =>
      auth.challenge(origin, certificate.replace("ib1.", "ib2.")),
    ).toThrow();
  });

  it("consumes bad-signature and wrong-origin challenges without authorizing replay", () => {
    const auth = new BrowserAuth(master);
    const key = identity();
    const { certificate } = auth.register(origin, {
      token: master,
      publicKey: key.publicKey,
    });
    const first = auth.challenge(origin, certificate).challenge;
    expect(() =>
      auth.exchange(origin, first, signed(identity().privateKey, first)),
    ).toThrow();
    expect(() =>
      auth.exchange(origin, first, signed(key.privateKey, first)),
    ).toThrow();
    const second = auth.challenge(origin, certificate).challenge;
    expect(() =>
      auth.exchange(other, second, signed(key.privateKey, second)),
    ).toThrow();
    expect(() =>
      auth.exchange(origin, second, signed(key.privateKey, second)),
    ).toThrow();
  });

  it("survives restart, expires challenges/access, and invalidates all authority on rotation", () => {
    let now = 1_000_000;
    const auth = new BrowserAuth(master, () => now);
    const key = identity();
    const { certificate } = auth.register(origin, {
      token: master,
      publicKey: key.publicKey,
    });
    const stale = auth.challenge(origin, certificate).challenge;
    now += AUTH_CHALLENGE_TTL_MS;
    expect(() =>
      auth.exchange(origin, stale, signed(key.privateKey, stale)),
    ).toThrow();
    const challenge = auth.challenge(origin, certificate).challenge;
    const access = auth.exchange(
      origin,
      challenge,
      signed(key.privateKey, challenge),
    );
    const restarted = new BrowserAuth(master, () => now);
    expect(restarted.accepts(access.bearer, origin)).toBe(true);
    expect(restarted.challenge(origin, certificate).challenge).toBeTruthy();
    expect(() =>
      restarted.exchange(origin, challenge, signed(key.privateKey, challenge)),
    ).toThrow();
    const rotated = new BrowserAuth("rotated", () => now);
    expect(rotated.accepts(access.bearer, origin)).toBe(false);
    expect(() => rotated.challenge(origin, certificate)).toThrow();
    now += BROWSER_ACCESS_TTL_MS;
    expect(auth.accepts(access.bearer, origin)).toBe(false);
  });

  it("bounds pending challenges and recovers capacity after expiry", () => {
    let now = 0;
    const auth = new BrowserAuth(master, () => now);
    const key = identity();
    const { certificate } = auth.register(origin, {
      token: master,
      publicKey: key.publicKey,
    });
    for (let i = 0; i < 1_024; i++) auth.challenge(origin, certificate);
    expect(() => auth.challenge(origin, certificate)).toThrow("Too many");
    now += AUTH_CHALLENGE_TTL_MS;
    expect(auth.challenge(origin, certificate).challenge).toBeTruthy();
  });

  it("binds one-use launch transfers and socket tickets to exact origin/audience/expiry", () => {
    let now = 0;
    const auth = new BrowserAuth(master, () => now);
    const key = identity();
    const bootstrap = auth.bootstrap(origin);
    expect(() =>
      auth.register(other, { bootstrap, publicKey: key.publicKey }),
    ).toThrow();
    expect(() =>
      auth.register(origin, { bootstrap, publicKey: key.publicKey }),
    ).toThrow();
    expect(
      auth.register(origin, {
        bootstrap: auth.bootstrap(origin),
        publicKey: key.publicKey,
      }).certificate,
    ).toBeTruthy();
    const ticket = auth.ticket(origin, "events").ticket;
    expect(auth.consumeTicket(ticket, origin, "terminal")).toBe(false);
    expect(auth.consumeTicket(ticket, origin, "events")).toBe(false);
    const valid = auth.ticket(origin, "events").ticket;
    expect(auth.consumeTicket(valid, origin, "events")).toBe(true);
    expect(auth.consumeTicket(valid, origin, "events")).toBe(false);
    const foreign = auth.ticket(origin, "terminal").ticket;
    expect(auth.consumeTicket(foreign, other, "terminal")).toBe(false);
    const stale = auth.ticket(origin, "events").ticket;
    now += BROWSER_TICKET_TTL_MS;
    expect(auth.consumeTicket(stale, origin, "events")).toBe(false);
    const expiredBootstrap = auth.bootstrap(origin);
    now += AUTH_CHALLENGE_TTL_MS;
    expect(() =>
      auth.register(origin, {
        bootstrap: expiredBootstrap,
        publicKey: key.publicKey,
      }),
    ).toThrow();
  });

  it("binds download grants, expires them and bounds all one-use admission pools", () => {
    let now = 0;
    const auth = new BrowserAuth(master, () => now);
    const valid = auth.downloadTicket(origin, "resource", "session").ticket;
    expect(auth.consumeDownload(valid, origin)).toEqual({
      resourceId: "resource",
      sessionId: "session",
    });
    expect(() => auth.consumeDownload(valid, origin)).toThrow();
    const foreign = auth.downloadTicket(origin, "resource", "session").ticket;
    expect(() => auth.consumeDownload(foreign, other)).toThrow();
    expect(() => auth.consumeDownload(foreign, origin)).toThrow();
    const expired = auth.downloadTicket(origin, "resource", "session").ticket;
    now += BROWSER_TICKET_TTL_MS;
    expect(() => auth.consumeDownload(expired, origin)).toThrow();
    for (const mint of [
      () => auth.downloadTicket(origin, "resource", "session"),
      () => auth.ticket(origin, "events"),
      () => auth.bootstrap(origin),
    ]) {
      for (let i = 0; i < 1_024; i++) mint();
      expect(mint).toThrow("Too many");
      now += AUTH_CHALLENGE_TTL_MS;
      expect(mint).not.toThrow();
    }
  });

  it("canonicalizes browser origins and rejects non-Host authorities", () => {
    expect(canonicalOrigin("EXAMPLE.test:443", true)).toBe(
      "https://example.test",
    );
    expect(canonicalOrigin("localhost:80", false)).toBe("http://localhost");
    for (const value of [
      "user@localhost",
      "localhost/path",
      "localhost?query",
      undefined,
    ])
      expect(() => canonicalOrigin(value, false)).toThrow();
  });
});
