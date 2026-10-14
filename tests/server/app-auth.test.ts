import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { accessCookieName } from "../../server/app.js";
import {
  hostApiFixture,
  closeHostApiFixture,
  pairedBrowser,
  socketAdmission,
  token,
} from "./fixtures/host-api.js";

async function rejectedSocket(
  url: string,
  options?: import("ws").ClientOptions,
) {
  const socket = new WebSocket(url, options);
  return new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", () => {});
    socket.once("open", () => {
      socket.close();
      reject(new Error("Unauthenticated socket opened"));
    });
  });
}

describe("Host browser authentication and asset access", () => {
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
  });
  afterEach(async () => closeHostApiFixture(fixture));

  it("preserves explicit bearer clients, rejects cookie/query authority and foreign origins", async () => {
    const { application, api, baseUrl } = fixture;
    await request(application.server).get("/api/bootstrap").expect(401);
    await api().set("Origin", "https://example.invalid").expect(403);
    await api().set("Origin", baseUrl.replace("http:", "https:")).expect(403);
    const response = await api().expect(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "img-src 'self' data: blob:",
    );
    expect(response.headers["content-security-policy"]).not.toMatch(
      /img-src[^;]*https:/,
    );
    expect(response.headers["content-security-policy"]).toContain(
      "media-src 'self' blob:",
    );
    await request(application.server)
      .get("/api/health")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { appName: "inspire", mock: true });
    await request(application.server)
      .post("/api/auth/pair")
      .send({ token })
      .expect(403);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token })
      .expect(400);
    const cookieName = accessCookieName(new URL(baseUrl).host);
    const legacy = await request(application.server)
      .get("/api/bootstrap")
      .set(
        "Cookie",
        `${cookieName}=${token}; inspire_access=${token}; unrelated=preserved; inspire_access_other=other`,
      )
      .expect(401);
    const cookies = String(legacy.headers["set-cookie"]);
    expect(cookies).toContain(`${cookieName}=;`);
    expect(cookies).toContain("inspire_access=;");
    expect(cookies).not.toContain("unrelated");
    expect(cookies).not.toContain("inspire_access_other");
    expect(
      await rejectedSocket(
        `${baseUrl.replace("http", "ws")}/events?token=${token}`,
      ),
    ).toBe(401);
    expect(
      await rejectedSocket(`${baseUrl.replace("http", "ws")}/events`, {
        headers: { Cookie: `${cookieName}=${token}` },
        origin: baseUrl,
      }),
    ).toBe(401);
  });

  it("pairs a public key, then requires exact-origin one-use event tickets", async () => {
    const { application, baseUrl } = fixture;
    const identity = await pairedBrowser(application.server, baseUrl);
    await request(application.server)
      .get("/api/bootstrap")
      .set("Authorization", `Bearer ${identity.bearer}`)
      .expect(200);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({
        token: identity.bearer,
        publicKey: {
          kty: "EC",
          crv: "P-256",
          x: identity.publicKey.x,
          y: identity.publicKey.y,
        },
      })
      .expect(401);
    const wrongAudience = await socketAdmission(
      application.server,
      baseUrl,
      identity.bearer,
      "terminal",
    );
    expect(
      await rejectedSocket(
        `${baseUrl.replace("http", "ws")}/events?ticket=${wrongAudience}`,
        { origin: baseUrl },
      ),
    ).toBe(401);
    const ticket = await socketAdmission(
      application.server,
      baseUrl,
      identity.bearer,
    );
    const url = `${baseUrl.replace("http", "ws")}/events?ticket=${ticket}`;
    const socket = new WebSocket(url, { origin: baseUrl });
    try {
      const frame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          socket.once("message", (data) =>
            resolve(JSON.parse(data.toString())),
          );
          socket.once("error", reject);
        },
      );
      expect(frame.type).toBe("snapshot");
    } finally {
      socket.close();
    }
    expect(await rejectedSocket(url, { origin: baseUrl })).toBe(401);
    const missingOrigin = await socketAdmission(
      application.server,
      baseUrl,
      identity.bearer,
    );
    expect(
      await rejectedSocket(
        `${baseUrl.replace("http", "ws")}/events?ticket=${missingOrigin}`,
      ),
    ).toBe(401);
    const foreign = await socketAdmission(
      application.server,
      baseUrl,
      identity.bearer,
    );
    expect(
      await rejectedSocket(
        `${baseUrl.replace("http", "ws")}/events?ticket=${foreign}`,
        { origin: "http://localhost:9999" },
      ),
    ).toBe(401);
  });

  it("binds certificates and access to canonical proxy origins, not another port", async () => {
    const { application } = fixture;
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const key = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const paired = await request(application.server)
      .post("/api/auth/pair")
      .set("Host", "EXAMPLE.test:443")
      .set("Origin", "https://example.test")
      .set("X-Forwarded-Proto", "https")
      .send({ token, publicKey: key })
      .expect(200);
    expect(paired.headers["set-cookie"]).toBeUndefined();
    const challenged = await request(application.server)
      .post("/api/auth/challenge")
      .set("Host", "example.test:443")
      .set("Origin", "https://example.test")
      .set("X-Forwarded-Proto", "https")
      .send({ certificate: paired.body.certificate })
      .expect(200);
    const challenge = challenged.body.challenge as string;
    const signature = sign("sha256", Buffer.from(challenge), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const exchanged = await request(application.server)
      .post("/api/auth/exchange")
      .set("Host", "EXAMPLE.test:443")
      .set("Origin", "https://example.test")
      .set("X-Forwarded-Proto", "https")
      .send({ challenge, signature })
      .expect(200);
    const bearer = exchanged.body.bearer as string;
    await request(application.server)
      .get("/api/bootstrap")
      .set("Host", "example.test:443")
      .set("X-Forwarded-Proto", "https")
      .set("Authorization", `Bearer ${bearer}`)
      .expect(200);
    const admission = await request(application.server)
      .post("/api/auth/socket-ticket")
      .set("Host", "example.test:443")
      .set("Origin", "https://example.test")
      .set("X-Forwarded-Proto", "https")
      .set("Authorization", `Bearer ${bearer}`)
      .send({ audience: "events" })
      .expect(200);
    const socket = new WebSocket(
      `${fixture.baseUrl.replace("http", "ws")}/events?ticket=${admission.body.ticket}`,
      {
        origin: "https://example.test",
        headers: { Host: "EXAMPLE.test:443", "X-Forwarded-Proto": "https" },
      },
    );
    try {
      const frame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          socket.once("message", (data) =>
            resolve(JSON.parse(data.toString())),
          );
          socket.once("error", reject);
        },
      );
      expect(frame.type).toBe("snapshot");
    } finally {
      socket.close();
    }
    await request(application.server)
      .post("/api/auth/challenge")
      .set("Host", "example.test:8443")
      .set("Origin", "https://example.test:8443")
      .set("X-Forwarded-Proto", "https")
      .send({ certificate: paired.body.certificate })
      .expect(401);
  });

  it("serves current/retained assets and exchanges only direct launch URLs for one-use fragments", async () => {
    const dist = await mkdtemp(join(tmpdir(), "inspire-auth-assets-"));
    const retained = await mkdtemp(join(tmpdir(), "inspire-auth-retained-"));
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "assets", "index-abc.js"), "current");
    await writeFile(join(retained, "old-abc.js"), "retained");
    await writeFile(join(retained, "index-abc.js"), "stale duplicate");
    await writeFile(join(dist, "theme-init.js"), "theme");
    await writeFile(join(dist, "index.html"), "<title>INSΠRE</title>");
    const served = await hostApiFixture({
      distDir: dist,
      staticAssetCacheDirs: [retained],
    });
    try {
      for (const asset of ["/assets/index-abc.js", "/assets/old-abc.js"]) {
        const response = await request(served.application.server)
          .get(asset)
          .expect(200);
        expect(response.headers["cache-control"]).toContain("immutable");
        expect(response.headers["cache-control"]).toContain("max-age=31536000");
        expect(response.text).toBe(
          asset.includes("index-abc") ? "current" : "retained",
        );
      }
      const missing = await request(served.application.server)
        .get("/assets/missing.js")
        .expect(404);
      expect(missing.text).toBe("Static asset not found");
      expect(missing.headers["content-type"]).toMatch(/^text\/plain/);
      expect(missing.headers["cache-control"]).toBe("no-store");
      const theme = await request(served.application.server)
        .get("/theme-init.js")
        .expect(200);
      expect(theme.headers["cache-control"]).not.toContain("immutable");
      expect(theme.headers["cache-control"]).toContain("max-age=0");
      for (const path of ["/", "/deep/route"]) {
        const shell = await request(served.application.server)
          .get(path)
          .expect(200);
        expect(shell.text).toContain("INSΠRE");
        expect(shell.headers["cache-control"]).toBe("no-cache");
      }
      const launch = await request(served.application.server)
        .get(`/?token=${token}`)
        .expect(303);
      expect(launch.headers.location).toMatch(
        /^\/#inspire-bootstrap=[A-Za-z0-9_-]+$/,
      );
      expect(launch.headers.location).not.toContain(token);
      expect(launch.headers["set-cookie"]).toBeUndefined();
      expect(launch.headers["referrer-policy"]).toBe("no-referrer");
      expect(launch.headers["cache-control"]).toBe("no-store");
      const bootstrap = new URL(
        launch.headers.location as string,
        served.baseUrl,
      ).hash.split("=")[1];
      const { publicKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      const jwk = publicKey.export({ format: "jwk" });
      const body = {
        bootstrap,
        publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      };
      await request(served.application.server)
        .post("/api/auth/pair")
        .set("Origin", served.baseUrl)
        .send(body)
        .expect(200);
      await request(served.application.server)
        .post("/api/auth/pair")
        .set("Origin", served.baseUrl)
        .send(body)
        .expect(401);
      const forwarded = await request(served.application.server)
        .get(`/?token=${token}`)
        .set("X-Forwarded-Proto", "https")
        .expect(303);
      expect(forwarded.headers.location).toBe("/");
      expect(forwarded.headers["set-cookie"]).toBeUndefined();
      const invalid = await request(served.application.server)
        .get("/?token=invalid")
        .expect(303);
      expect(invalid.headers.location).toBe("/");
      await request(served.application.server)
        .get("/api/not-a-route")
        .set("Authorization", `Bearer ${token}`)
        .expect(404, { error: "API route not found" });
    } finally {
      await closeHostApiFixture(served);
      await rm(dist, { recursive: true, force: true });
      await rm(retained, { recursive: true, force: true });
    }
  });
});
