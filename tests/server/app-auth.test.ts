import { generateKeyPairSync, sign } from "node:crypto";
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

describe("Host browser authentication", () => {
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
    const configure = (bearer: string, patch: object, origin = baseUrl) =>
      request(application.server)
        .put("/api/notifications")
        .set("Origin", origin)
        .set("Authorization", `Bearer ${bearer}`)
        .send(patch);
    await configure(first.bearer, { mode: "title" }).expect(200);
    const grouped = await configure(first.bearer, {
      grouping: "project",
    }).expect(200);
    expect(grouped.body).toMatchObject({ mode: "title", grouping: "project" });
    expect((await settings(second.bearer).expect(200)).body).toMatchObject({
      mode: "off",
      grouping: "session",
    });
    await configure(first.bearer, { grouping: "invalid" }).expect(400);
    await configure(token, { mode: "desktop" }).expect(401);
    await configure(first.bearer, { mode: "off" }, "https://other.test").expect(
      403,
    );
    expect((await settings(first.bearer).expect(200)).body).toMatchObject({
      mode: "title",
      grouping: "project",
    });

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
      await configure(first.bearer, { subscription: null }).expect(200);
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

  it("binds browser credentials and one-use event tickets to the canonical proxy origin", async () => {
    const { application, baseUrl } = fixture;
    const origin = "https://example.test";
    const headers = { Host: "EXAMPLE.test:443", "X-Forwarded-Proto": "https" };
    const browser = request(application.server);
    const post = (path: string) =>
      browser.post(path).set({ ...headers, Origin: origin });
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
    const key = { kty, crv, x, y };
    const paired = await post("/api/auth/pair")
      .send({ token, publicKey: key })
      .expect(200);
    expect(paired.headers["set-cookie"]).toBeUndefined();
    const { certificate } = paired.body;
    const challenged = await post("/api/auth/challenge")
      .send({ certificate })
      .expect(200);
    const challenge = challenged.body.challenge as string;
    const signature = sign("sha256", Buffer.from(challenge), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const exchanged = await post("/api/auth/exchange")
      .send({ challenge, signature })
      .expect(200);
    const bearer = exchanged.body.bearer as string;
    const authorization = `Bearer ${bearer}`;
    await browser
      .get("/api/bootstrap")
      .set({ ...headers, Authorization: authorization })
      .expect(200);
    await post("/api/auth/pair")
      .send({ token: bearer, publicKey: key })
      .expect(401);
    await browser
      .post("/api/auth/challenge")
      .set({
        ...headers,
        Host: "example.test:8443",
        Origin: "https://example.test:8443",
      })
      .send({ certificate })
      .expect(401);

    const eventUrl = async (audience = "events") => {
      const admission = await post("/api/auth/socket-ticket")
        .set("Authorization", authorization)
        .send({ audience })
        .expect(200);
      return `${baseUrl.replace("http", "ws")}/events?ticket=${admission.body.ticket}`;
    };
    const url = await eventUrl();
    const socket = new WebSocket(url, { origin, headers });
    try {
      const type = await new Promise<string>((resolve, reject) => {
        socket.once("message", (data) =>
          resolve(JSON.parse(String(data)).type),
        );
        socket.once("error", reject);
      });
      expect(type).toBe("snapshot");
    } finally {
      socket.close();
    }
    expect(await rejectedSocket(url, { origin, headers })).toBe(401);
    expect(
      await rejectedSocket(await eventUrl("terminal"), { origin, headers }),
    ).toBe(401);
    expect(await rejectedSocket(await eventUrl(), { headers })).toBe(401);
    expect(
      await rejectedSocket(await eventUrl(), {
        origin: "https://example.test:8443",
        headers,
      }),
    ).toBe(401);
  });
});
