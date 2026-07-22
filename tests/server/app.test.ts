import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AttachmentStore } from "../../server/attachments.js";
import { createInspireServer } from "../../server/app.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import { PreferencesStore } from "../../server/preferences.js";

const token = "test-local-token";

describe("local host API", () => {
  let temporary: string;
  let application: ReturnType<typeof createInspireServer>;
  let baseUrl: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "inspire-test-"));
    application = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads")),
      preferences: new PreferencesStore(join(temporary, "preferences.json")),
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: join(temporary, "missing-dist"),
    });
    await new Promise<void>((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    const address = application.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const api = () => request(application.server).get("/api/bootstrap").set("Authorization", `Bearer ${token}`);

  it("requires the launch token and rejects foreign origins", async () => {
    await request(application.server).get("/api/bootstrap").expect(401);
    await api().set("Origin", "https://example.invalid").expect(403);
    const response = await api().expect(200);
    expect(response.body).toMatchObject({ appName: "insπre", mock: true, piVersion: "0.80.10" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("lists and opens Pi sessions through the typed API", async () => {
    const sessions = await request(application.server)
      .get("/api/sessions?q=formula")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(sessions.body.total).toBe(1);
    expect(sessions.body.sessions[0]).toMatchObject({ id: "mock-active", project: "research" });
    await request(application.server)
      .get("/api/sessions?limit=not-a-number")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    const opened = await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    expect(opened.body.active.messages).toHaveLength(3);
    expect(opened.body.active.model.id).toBe("kimi-k3");
  });

  it("persists validated interface preferences", async () => {
    const value = {
      theme: "dark",
      launch: "continue",
      thinkingVisibility: "expanded",
      toolVisibility: "hidden",
      readingSerif: true,
    };
    await request(application.server)
      .put("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send(value)
      .expect(200, value);
    await request(application.server)
      .put("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...value, theme: "sepia" })
      .expect(400);
    const stored = await request(application.server)
      .get("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(stored.body).toEqual(value);
  });

  it("accepts bounded attachments and streams prompt events over an authenticated socket", async () => {
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);

    const uploaded = await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.from("research notes"), { filename: "notes.txt", contentType: "text/plain" })
      .expect(200);
    expect(uploaded.body.attachments[0]).toMatchObject({ fileName: "notes.txt", kind: "file", size: 14 });
    expect(uploaded.body.attachments[0]).not.toHaveProperty("path");

    const events: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/events?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as Record<string, unknown>));

    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Integrate this note", attachmentIds: [uploaded.body.attachments[0].id] })
      .expect(202, { accepted: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("mock stream did not settle")), 2_000);
      const poll = setInterval(() => {
        if (!events.some((event) => event.type === "agent_settled")) return;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }, 10);
    });
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    socket.close();
  });
});
