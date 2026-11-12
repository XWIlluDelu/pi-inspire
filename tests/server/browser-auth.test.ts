import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAccessToken } from "../../server/access-token.js";
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
    expect(auth.verifyAccess(certificate, origin)).toBeNull();
    expect(auth.verifyAccess(master, origin)).toBeNull();
    const { challenge } = auth.challenge(origin, certificate);
    const access = auth.exchange(
      origin,
      challenge,
      signed(key.privateKey, challenge),
    );
    expect(auth.verifyAccess(access.bearer, origin)).toMatchObject({
      browserId: expect.any(String),
    });
    expect(auth.verifyAccess(access.bearer, other)).toBeNull();
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
    expect(restarted.verifyAccess(access.bearer, origin)).toEqual(
      auth.verifyAccess(access.bearer, origin),
    );
    expect(restarted.challenge(origin, certificate).challenge).toBeTruthy();
    expect(() =>
      restarted.exchange(origin, challenge, signed(key.privateKey, challenge)),
    ).toThrow();
    const rotated = new BrowserAuth("rotated", () => now);
    expect(rotated.verifyAccess(access.bearer, origin)).toBeNull();
    expect(() => rotated.challenge(origin, certificate)).toThrow();
    now += BROWSER_ACCESS_TTL_MS;
    expect(auth.verifyAccess(access.bearer, origin)).toBeNull();
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
    expect(auth.consumeTicketGrant(ticket, origin, "terminal")).toBeNull();
    expect(auth.consumeTicketGrant(ticket, origin, "events")).toBeNull();
    const valid = auth.ticket(origin, "events", "paired-installation").ticket;
    expect(auth.consumeTicketGrant(valid, origin, "events")).toMatchObject({
      origin,
      browserId: "paired-installation",
    });
    expect(auth.consumeTicketGrant(valid, origin, "events")).toBeNull();
    const foreign = auth.ticket(origin, "terminal").ticket;
    expect(auth.consumeTicketGrant(foreign, other, "terminal")).toBeNull();
    const stale = auth.ticket(origin, "events").ticket;
    now += BROWSER_TICKET_TTL_MS;
    expect(auth.consumeTicketGrant(stale, origin, "events")).toBeNull();
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

describe("persistent host access token", () => {
  const temporaryDirectories: string[] = [];

  async function temporaryPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "inspire-access-token-"));
    temporaryDirectories.push(directory);
    return join(directory, "private", "access.token");
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates one private token and reuses it across host starts", async () => {
    const path = await temporaryPath();
    const first = await resolveAccessToken(undefined, path);
    const second = await resolveAccessToken(undefined, path);

    expect(first).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(second).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a shared parent without changing its permissions or creating a token",
    async () => {
      const path = await temporaryPath();
      await mkdir(dirname(path), { recursive: true });
      await chmod(dirname(path), 0o1777);
      await expect(resolveAccessToken(undefined, path)).rejects.toThrow(
        "use a private directory",
      );
      expect((await lstat(dirname(path))).mode & 0o7777).toBe(0o1777);
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rotates prior generated token lengths once and then reuses the replacement", async () => {
    for (const length of [43, 64, 128]) {
      const path = await temporaryPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const legacy = "a".repeat(length);
      await writeFile(path, `${legacy}\n`, { mode: 0o600 });

      const rotated = await resolveAccessToken(undefined, path);
      expect(rotated).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(rotated).not.toBe(legacy);
      expect((await readFile(path, "utf8")).trim()).toBe(rotated);
      await expect(resolveAccessToken(undefined, path)).resolves.toBe(rotated);
    }
  });

  it("keeps an explicit environment token outside persistent storage", async () => {
    const path = await temporaryPath();
    await expect(resolveAccessToken("explicit-test-token", path)).resolves.toBe(
      "explicit-test-token",
    );
    await expect(resolveAccessToken("", path)).rejects.toThrow(
      "between 1 and 256 characters",
    );
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "refuses a token path that redirects through a symbolic link",
    async () => {
      const path = await temporaryPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const target = join(dirname(path), "target.token");
      await writeFile(target, `${"a".repeat(64)}\n`, { mode: 0o600 });
      await symlink(target, path);

      await expect(resolveAccessToken(undefined, path)).rejects.toThrow(
        "not a regular file",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a token file exposed to other local users",
    async () => {
      const path = await temporaryPath();
      await resolveAccessToken(undefined, path);
      await chmod(path, 0o644);
      await expect(resolveAccessToken(undefined, path)).rejects.toThrow(
        "must not be accessible by other users",
      );
    },
  );
});
