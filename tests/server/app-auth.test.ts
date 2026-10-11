import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { accessCookieName } from "../../server/app.js";

import {
  hostApiFixture,
  closeHostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("local Host authentication and asset access", () => {
  let application: Awaited<ReturnType<typeof hostApiFixture>>["application"];
  let baseUrl: Awaited<ReturnType<typeof hostApiFixture>>["baseUrl"];
  let api: Awaited<ReturnType<typeof hostApiFixture>>["api"];
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({ application, baseUrl, api } = fixture);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  it("requires the launch token and rejects foreign origins", async () => {
    await request(application.server).get("/api/bootstrap").expect(401);
    await api().set("Origin", "https://example.invalid").expect(403);
    await api()
      .set("Origin", `https://${new URL(baseUrl).host}`)
      .expect(403);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", "https://example.invalid")
      .send({ token })
      .expect(403);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", `https://${new URL(baseUrl).host}`)
      .send({ token })
      .expect(403);
    const health = await request(application.server)
      .get("/api/health")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(health.body).toEqual({ appName: "inspire", mock: true });
    const response = await api().expect(200);
    expect(response.body).toMatchObject({
      appName: "inspire",
      mock: true,
      piVersion: "0.80.10",
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
      ],
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    // Remote images are barred so untrusted transcript content cannot fire
    // network requests just by rendering.
    expect(response.headers["content-security-policy"]).toContain(
      "img-src 'self' data: blob:",
    );
    expect(response.headers["content-security-policy"]).not.toMatch(
      /img-src[^;]*https:/,
    );
    expect(response.headers["content-security-policy"]).toContain(
      "media-src 'self' blob:",
    );
  });

  it("pairs a browser once with an HttpOnly same-site cookie for HTTP and WebSocket access", async () => {
    const agent = request.agent(application.server);
    await agent
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token: "wrong" })
      .expect(401);
    const paired = await agent
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token })
      .expect(204);
    const setCookie = paired.headers["set-cookie"] as unknown as string[];
    expect(setCookie[0]).toContain(
      `${accessCookieName(new URL(baseUrl).host)}=`,
    );
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("SameSite=Strict");
    expect(setCookie[0]).toContain("Path=/");
    await agent.get("/api/bootstrap").expect(200);

    const cookieName = accessCookieName(new URL(baseUrl).host);
    const cookie = setCookie[0]!.split(";", 1)[0]!;
    await request(application.server)
      .get("/api/bootstrap")
      .set("Cookie", `${cookieName}=stale; ${cookie}`)
      .expect(200);
    const expired = await request(application.server)
      .get("/api/bootstrap")
      .set("Cookie", `${cookieName}=stale`)
      .expect(401);
    expect(String(expired.headers["set-cookie"])).toContain(`${cookieName}=`);
    expect(String(expired.headers["set-cookie"])).toContain(
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );

    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/events`, {
      headers: { Cookie: cookie },
      origin: baseUrl,
    });
    try {
      const firstFrame = await new Promise<Record<string, unknown>>(
        (resolveFrame, reject) => {
          socket.once("message", (data) =>
            resolveFrame(
              JSON.parse(data.toString()) as Record<string, unknown>,
            ),
          );
          socket.once("error", reject);
        },
      );
      expect(firstFrame.type).toBe("snapshot");
    } finally {
      socket.close();
    }
  });

  it("keeps pairing cookies independent across Host ports", async () => {
    const otherToken = "other-local-token";
    const otherFixture = await hostApiFixture({ token: otherToken });
    const other = otherFixture.application;
    const firstHost = "127.0.0.1:4587";
    const secondHost = "127.0.0.1:4588";
    try {
      const first = await request(application.server)
        .post("/api/auth/pair")
        .set("Host", firstHost)
        .set("Origin", `http://${firstHost}`)
        .send({ token })
        .expect(204);
      const second = await request(other.server)
        .post("/api/auth/pair")
        .set("Host", secondHost)
        .set("Origin", `http://${secondHost}`)
        .send({ token: otherToken })
        .expect(204);
      const firstCookie = String(first.headers["set-cookie"]).split(";", 1)[0]!;
      const secondCookie = String(second.headers["set-cookie"]).split(
        ";",
        1,
      )[0]!;
      expect(firstCookie).toContain(`${accessCookieName(firstHost)}=`);
      expect(secondCookie).toContain(`${accessCookieName(secondHost)}=`);
      expect(accessCookieName(firstHost)).not.toBe(
        accessCookieName(secondHost),
      );
      const cookies = `${firstCookie}; ${secondCookie}`;

      await request(application.server)
        .get("/api/bootstrap")
        .set("Host", firstHost)
        .set("Origin", `http://${firstHost}`)
        .set("Cookie", cookies)
        .expect(200);
      await request(other.server)
        .get("/api/bootstrap")
        .set("Host", secondHost)
        .set("Origin", `http://${secondHost}`)
        .set("Cookie", cookies)
        .expect(200);
    } finally {
      await closeHostApiFixture(otherFixture);
    }
  });

  it("sets a Secure pairing cookie through a trusted loopback HTTPS proxy", async () => {
    const proxiedFixture = await hostApiFixture();
    const proxied = proxiedFixture.application;
    try {
      const paired = await request(proxied.server)
        .post("/api/auth/pair")
        .set("Host", "inspire.example.test")
        .set("Origin", "https://inspire.example.test")
        .set("X-Forwarded-Proto", "https")
        .send({ token })
        .expect(204);
      expect(String(paired.headers["set-cookie"])).toContain("Secure");
    } finally {
      await closeHostApiFixture(proxiedFixture);
    }
  });

  it("serves current and retained hashed assets without using the SPA fallback", async () => {
    const dist = await mkdtemp(join(tmpdir(), ".inspire-dist-"));
    const retainedAssets = await mkdtemp(
      join(tmpdir(), "inspire-retained-assets-"),
    );
    await mkdir(join(dist, "assets"));
    await writeFile(
      join(dist, "assets", "index-abc123.js"),
      "console.log(1)\n",
    );
    await writeFile(
      join(retainedAssets, "index-abc123.js"),
      "console.log('stale duplicate')\n",
    );
    await writeFile(
      join(retainedAssets, "ContextPane-old123.js"),
      "export const ContextPane = {}\n",
    );
    await writeFile(join(dist, "theme-init.js"), "/* theme */\n");
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>INSΠRE</title>",
    );
    const servedFixture = await hostApiFixture({
      distDir: dist,
      staticAssetCacheDirs: [retainedAssets],
    });
    const served = servedFixture.application;
    try {
      const hashed = await request(served.server)
        .get("/assets/index-abc123.js")
        .expect(200);
      expect(hashed.headers["cache-control"]).toContain("immutable");
      expect(hashed.headers["cache-control"]).toContain("max-age=31536000");
      expect(hashed.text).toBe("console.log(1)\n");
      const retained = await request(served.server)
        .get("/assets/ContextPane-old123.js")
        .expect(200);
      expect(retained.text).toBe("export const ContextPane = {}\n");
      expect(retained.headers["cache-control"]).toContain("immutable");
      const missingAsset = await request(served.server)
        .get("/assets/ContextPane-missing.js")
        .expect(404);
      expect(missingAsset.headers["content-type"]).toMatch(/^text\/plain/u);
      expect(missingAsset.headers["cache-control"]).toBe("no-store");
      expect(missingAsset.text).toBe("Static asset not found");
      expect(missingAsset.text).not.toContain("<title>INSΠRE</title>");
      // Unhashed root script must revalidate, never inherit the 1y policy.
      const theme = await request(served.server)
        .get("/theme-init.js")
        .expect(200);
      expect(theme.headers["cache-control"]).not.toContain("immutable");
      expect(theme.headers["cache-control"]).toContain("max-age=0");
      // The SPA shell is always revalidated so a new bundle hash is picked up.
      for (const path of ["/", "/some/deep/route"]) {
        const shell = await request(served.server).get(path).expect(200);
        expect(shell.text).toContain("<title>INSΠRE</title>");
        expect(shell.headers["cache-control"]).toBe("no-cache");
      }

      const browser = request.agent(served.server);
      const launch = await browser
        .get(`/?token=${encodeURIComponent(token)}`)
        .redirects(0)
        .expect(303);
      expect(launch.headers.location).toBe("/");
      expect(String(launch.headers["set-cookie"])).toContain("inspire_access_");
      await browser.get("/api/bootstrap").expect(200);
      const missingApi = await browser.get("/api/not-a-route").expect(404);
      expect(missingApi.body).toEqual({ error: "API route not found" });
    } finally {
      await closeHostApiFixture(servedFixture);
      await rm(dist, { recursive: true, force: true });
      await rm(retainedAssets, { recursive: true, force: true });
    }
  });

  it("keeps direct token URLs local and rejects them through forwarded HTTPS", async () => {
    const dist = await mkdtemp(join(tmpdir(), "inspire-relay-dist-"));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>INSΠRE</title>",
    );
    const relayFixture = await hostApiFixture({ distDir: dist });
    const relay = relayFixture.application;
    const address = relay.server.address() as AddressInfo;
    const forwardedOrigin = `https://127.0.0.1:${address.port}`;
    try {
      const direct = request.agent(relay.server);
      const directLaunch = await direct
        .get(`/?token=${encodeURIComponent(token)}`)
        .redirects(0)
        .expect(303);
      expect(directLaunch.headers.location).toBe("/");
      expect(String(directLaunch.headers["set-cookie"])).toContain(
        "inspire_access_",
      );
      expect(String(directLaunch.headers["set-cookie"])).not.toContain(
        "Secure",
      );
      await direct.get("/api/bootstrap").expect(200);

      const forwardedLaunch = await request(relay.server)
        .get(`/?token=${encodeURIComponent(token)}`)
        .set("X-Forwarded-Proto", "https")
        .redirects(0)
        .expect(303);
      expect(forwardedLaunch.headers.location).toBe("/");
      expect(String(forwardedLaunch.headers["set-cookie"])).not.toContain(
        "inspire_access_",
      );

      await request(relay.server)
        .post("/api/auth/pair")
        .set("Origin", forwardedOrigin.replace("https:", "http:"))
        .set("X-Forwarded-Proto", "https")
        .send({ token })
        .expect(403);

      const paired = await request(relay.server)
        .post("/api/auth/pair")
        .set("Origin", forwardedOrigin)
        .set("X-Forwarded-Proto", "https")
        .send({ token })
        .expect(204);
      const cookie = String(paired.headers["set-cookie"]).split(";", 1)[0]!;
      expect(String(paired.headers["set-cookie"])).toContain("Secure");

      const rejected = new WebSocket(
        `ws://127.0.0.1:${address.port}/events?token=${encodeURIComponent(token)}`,
        {
          headers: { "X-Forwarded-Proto": "https" },
          origin: forwardedOrigin,
        },
      );
      await new Promise<void>((resolveRejected, rejectRejected) => {
        rejected.once("open", () =>
          rejectRejected(new Error("forwarded query-token socket opened")),
        );
        rejected.once("close", () => resolveRejected());
        rejected.once("error", () => resolveRejected());
      });

      // Forwarded query credentials remain ineligible, but a stale page may
      // still append one after it has a valid pairing cookie. Ignore that
      // parameter rather than vetoing the independently authenticated cookie.
      const stalePageSocket = new WebSocket(
        `ws://127.0.0.1:${address.port}/events?token=stale-page-token`,
        {
          headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
          origin: forwardedOrigin,
        },
      );
      try {
        const firstFrame = await new Promise<Record<string, unknown>>(
          (resolveFrame, rejectFrame) => {
            stalePageSocket.once("message", (data) =>
              resolveFrame(
                JSON.parse(data.toString()) as Record<string, unknown>,
              ),
            );
            stalePageSocket.once("error", rejectFrame);
          },
        );
        expect(firstFrame.type).toBe("snapshot");
      } finally {
        stalePageSocket.close();
      }

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events`, {
        headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
        origin: forwardedOrigin,
      });
      try {
        const firstFrame = await new Promise<Record<string, unknown>>(
          (resolveFrame, rejectFrame) => {
            socket.once("message", (data) =>
              resolveFrame(
                JSON.parse(data.toString()) as Record<string, unknown>,
              ),
            );
            socket.once("error", rejectFrame);
          },
        );
        expect(firstFrame.type).toBe("snapshot");
      } finally {
        socket.close();
      }
    } finally {
      await closeHostApiFixture(relayFixture);
      await rm(dist, { recursive: true, force: true });
    }
  });
});
