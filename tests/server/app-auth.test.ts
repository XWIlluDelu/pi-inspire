import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  closeHostApiFixture,
  hostApiFixture,
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

  it("binds notification settings and event routing to the proved browser key", async () => {
    const { application, baseUrl, runtime } = fixture;
    const first = await pairedBrowser(application.server, baseUrl);
    const second = await pairedBrowser(application.server, baseUrl);
    const settings = (bearer: string) =>
      request(application.server)
        .get("/api/notifications")
        .set("Origin", baseUrl)
        .set("Authorization", `Bearer ${bearer}`);
    const configure = (bearer: string) =>
      request(application.server)
        .put("/api/notifications")
        .set("Origin", baseUrl)
        .set("Authorization", `Bearer ${bearer}`)
        .send({ mode: "title" });
    await configure(first.bearer).expect(200);
    const grouped = await request(application.server)
      .put("/api/notifications")
      .set("Origin", baseUrl)
      .set("Authorization", `Bearer ${first.bearer}`)
      .send({ grouping: "project" })
      .expect(200);
    expect(grouped.body).toMatchObject({ mode: "title", grouping: "project" });
    expect((await settings(second.bearer).expect(200)).body.grouping).toBe(
      "session",
    );
    await request(application.server)
      .put("/api/notifications")
      .set("Origin", baseUrl)
      .set("Authorization", `Bearer ${first.bearer}`)
      .send({ grouping: "invalid" })
      .expect(400);
    expect((await settings(first.bearer).expect(200)).body.mode).toBe("title");
    expect((await settings(second.bearer).expect(200)).body.mode).toBe("off");
    await request(application.server)
      .put("/api/notifications")
      .set("Origin", baseUrl)
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "desktop" })
      .expect(401);
    await request(application.server)
      .put("/api/notifications")
      .set("Origin", "https://other.test")
      .set("Authorization", `Bearer ${first.bearer}`)
      .send({ mode: "off" })
      .expect(403);

    const ticket = await socketAdmission(
      application.server,
      baseUrl,
      first.bearer,
    );
    const socket = new WebSocket(
      `${baseUrl.replace("http", "ws")}/events?ticket=${ticket}`,
      { origin: baseUrl },
    );
    const received: Record<string, unknown>[] = [];
    socket.on("message", (message) =>
      received.push(JSON.parse(String(message))),
    );
    try {
      await new Promise<void>((resolve) => socket.once("open", resolve));
      await vi.waitFor(() => expect(received[0]?.type).toBe("snapshot"));
      runtime.emit("event", { type: "agent_start", sessionId: "background" });
      runtime.emit("event", {
        type: "agent_settled",
        sessionId: "background",
        sessionStatus: { runState: "failed" },
      });
      await vi.waitFor(() =>
        expect(received.some((item) => item.type === "task_notification")).toBe(
          true,
        ),
      );
      expect(
        received.find((item) => item.type === "task_alert_settings")?.settings,
      ).toMatchObject({ mode: "title" });
      await request(application.server)
        .put("/api/notifications")
        .set("Origin", baseUrl)
        .set("Authorization", `Bearer ${first.bearer}`)
        .send({ subscription: null })
        .expect(200);
      expect((await settings(first.bearer).expect(200)).body.mode).toBe(
        "title",
      );
      const frame = received.find((item) => item.type === "task_notification")!;
      expect(frame.notification).toMatchObject({
        sessionId: "background",
        outcome: "failed",
      });
    } finally {
      socket.close();
    }
  });

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
      .expect(200, { appName: "inspire" });
    await request(application.server)
      .post("/api/auth/pair")
      .send({ token })
      .expect(403);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token })
      .expect(400);
    const cookie = `inspire_access=${token}`;
    await request(application.server)
      .get("/api/bootstrap")
      .set("Cookie", cookie)
      .expect(401);
    await request(application.server)
      .get("/api/bootstrap")
      .query({ token })
      .expect(401);
    expect(
      await rejectedSocket(
        `${baseUrl.replace("http", "ws")}/events?token=${token}`,
      ),
    ).toBe(401);
    expect(
      await rejectedSocket(`${baseUrl.replace("http", "ws")}/events`, {
        headers: { Cookie: cookie },
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

  it("negotiates build-time compression without changing asset types, validators, or ranges", async () => {
    const dist = await mkdtemp(join(tmpdir(), "inspire-auth-encoding-"));
    const retained = join(dist, "retained");
    const assets = join(dist, "assets");
    const source = 'console.log("fixture");\n'.repeat(100);
    const css = ".fixture { display: block; }\n".repeat(100);
    await Promise.all([mkdir(assets), mkdir(retained)]);
    await Promise.all([
      writeFile(join(dist, "index.html"), "index"),
      writeFile(join(assets, "app-hashed.js"), source),
      writeFile(join(assets, "app-hashed.js.br"), brotliCompressSync(source)),
      writeFile(join(assets, "app-hashed.js.gz"), gzipSync(source)),
      writeFile(join(retained, "old-hashed.css"), css),
      writeFile(join(retained, "old-hashed.css.gz"), gzipSync(css)),
    ]);
    const served = await hostApiFixture({
      distDir: dist,
      staticAssetCacheDirs: [retained],
    });
    try {
      const url = `${served.baseUrl}/assets/app-hashed.js?v=1`;
      const br = await fetch(url, {
        headers: { "Accept-Encoding": "br, gzip" },
      });
      expect(br.status).toBe(200);
      expect(br.headers.get("content-type")).toMatch(/^text\/javascript/);
      expect(br.headers.get("content-encoding")).toBe("br");
      expect(br.headers.get("cache-control")).toContain("immutable");
      expect(br.headers.get("vary")).toBe("Accept-Encoding");
      expect(Number(br.headers.get("content-length"))).toBeLessThan(
        Buffer.byteLength(source),
      );
      expect(await br.text()).toBe(source);

      const head = await request(served.application.server)
        .head("/assets/app-hashed.js")
        .set("Accept-Encoding", "gzip, br;q=0.5")
        .expect(200);
      expect(head.headers["content-encoding"]).toBe("gzip");
      expect(head.headers.etag).not.toBe(br.headers.get("etag"));
      await request(served.application.server)
        .get("/assets/app-hashed.js")
        .set("Accept-Encoding", "br")
        .set("If-None-Match", br.headers.get("etag")!)
        .expect(304)
        .expect("Vary", "Accept-Encoding");

      const identity = await fetch(url, {
        headers: { "Accept-Encoding": "br;q=0, gzip;q=0" },
      });
      expect(identity.headers.get("content-encoding")).toBeNull();
      expect(identity.headers.get("vary")).toBe("Accept-Encoding");
      expect(await identity.text()).toBe(source);
      const range = await fetch(url, {
        headers: { "Accept-Encoding": "br, gzip", Range: "bytes=0-6" },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-encoding")).toBeNull();
      expect(range.headers.get("content-range")).toBe(
        `bytes 0-6/${Buffer.byteLength(source)}`,
      );
      expect(await range.text()).toBe(source.slice(0, 7));

      const old = await fetch(`${served.baseUrl}/assets/old-hashed.css`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(old.status).toBe(200);
      expect(old.headers.get("content-type")).toMatch(/^text\/css/);
      expect(old.headers.get("content-encoding")).toBe("gzip");
      expect(await old.text()).toBe(css);
    } finally {
      await closeHostApiFixture(served);
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("serves current and retained assets and keeps API errors out of the app shell", async () => {
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
      for (const path of ["/", `/?token=${token}`, "/deep/route"]) {
        const shell = await request(served.application.server)
          .get(path)
          .expect(200);
        expect(shell.text).toContain("INSΠRE");
        expect(shell.headers["cache-control"]).toBe("no-cache");
      }
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
