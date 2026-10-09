import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import { PreferencesStore } from "../../server/preferences.js";
import { type ResourceContext, ResourceStore } from "../../server/resources.js";
import { HTML_PREVIEW_BYTES } from "../../shared/html-preview.js";

describe("interactive HTML capabilities", () => {
  let temporary: string;
  let application: ReturnType<typeof createInspireServer>;
  let resources: ResourceStore;
  let context: ResourceContext & { messages: unknown[]; loadMessages?: never };
  const token = "html-preview-test";
  const html = "<h1>Loaded snapshot</h1><script>window.ready = true</script>";
  let source: string;

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), "inspire-html-")));
    const cwd = join(temporary, "project");
    await mkdir(join(cwd, "pages"), { recursive: true });
    source = join(cwd, "pages", "demo.html");
    await writeFile(source, html);
    await writeFile(join(cwd, "asset.js"), 'export const value = "local";');
    await writeFile(join(cwd, "pages", "media.mp4"), "0123456789");
    await writeFile(join(temporary, "private.txt"), "outside");
    context = {
      sessionId: "s1",
      viewId: "view-1",
      revision: 1,
      cwd,
      messages: [],
    };
    resources = new ResourceStore();
    const runtime = new MockRuntime();
    vi.spyOn(runtime, "resourceContext").mockImplementation(
      async () => context,
    );
    application = createInspireServer({
      token,
      runtime,
      resources,
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads")),
      preferences: new PreferencesStore(join(temporary, "preferences.json")),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async () => {
          throw new Error("Not used");
        },
      },
      mock: true,
      version: "test",
      piVersion: "test",
      distDir: join(temporary, "missing-dist"),
    });
  });
  afterEach(async () => {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  });

  async function start(reference = "pages/demo.html", snapshot = html) {
    const descriptor = await resources.resolve(context, reference);
    const response = await request(application.app)
      .post(`/api/resources/${descriptor.id}/interactive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: context.sessionId, html: snapshot });
    expect(response.status).toBe(200);
    return { ...(response.body as { id: string; url: string }), descriptor };
  }

  it("requires explicit authenticated creation and runs the loaded snapshot under its own policy", async () => {
    const descriptor = await resources.resolve(context, "pages/demo.html");
    await request(application.app)
      .post(`/api/resources/${descriptor.id}/interactive`)
      .send({ sessionId: "s1", html })
      .expect(401);
    const grant = await start();
    await writeFile(source, "<h1>Later edit</h1>");
    const served = await request(application.app).get(grant.url).expect(200);
    expect(served.text).toBe(html);
    expect(served.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts",
    );
    expect(served.headers["content-security-policy"]).not.toContain(
      "allow-same-origin",
    );
    expect(served.headers["content-security-policy"]).toContain("https:");
    expect(served.headers["cache-control"]).toBe("no-store");
    expect(served.headers["set-cookie"]).toBeUndefined();
    const ordinary = await request(application.app)
      .get(`/api/resources/${descriptor.id}/content?sessionId=s1`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(ordinary.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(ordinary.headers["content-security-policy"]).not.toContain(
      "unsafe-eval",
    );
    await request(application.app)
      .get("/api/snapshot")
      .set("Origin", "null")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("serves relative modules and ranged media with opaque-origin CORS, not Host credentials", async () => {
    const grant = await start();
    const prefix = grant.url.split("/pages/")[0]!;
    const module = await request(application.app)
      .get(`${prefix}/asset.js`)
      .set("Origin", "null")
      .expect(200);
    expect(module.text).toContain("export const value");
    expect(module.headers["content-type"]).toMatch(/javascript/);
    expect(module.headers["access-control-allow-origin"]).toBe("*");
    expect(module.headers["access-control-allow-credentials"]).toBeUndefined();
    const media = await request(application.app)
      .get(`${prefix}/pages/media.mp4`)
      .set("Range", "bytes=2-4")
      .expect(206);
    expect(media.headers["content-range"]).toBe("bytes 2-4/10");
    expect(media.body.toString()).toBe("234");
    await request(application.app)
      .get(`${prefix}/pages/media.mp4`)
      .set("Range", "bytes=100-")
      .expect(416);
  });

  it("confines local assets to the granted root, including symlink targets", async () => {
    const grant = await start();
    const prefix = grant.url.split("/pages/")[0]!;
    await request(application.app)
      .get(`${prefix}/..%2fprivate.txt`)
      .expect(403);
    if (process.platform !== "win32") {
      await symlink(
        join(temporary, "private.txt"),
        join(context.cwd, "escape.txt"),
      );
      await request(application.app).get(`${prefix}/escape.txt`).expect(403);
    }
    await request(application.app).get(`${prefix}/missing.js`).expect(404);
  });

  it("revokes on stop and refuses a retired branch view or replaced entry file", async () => {
    const stopped = await start();
    await request(application.app)
      .delete(`/api/html-previews/${stopped.id}?sessionId=other`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    await request(application.app).get(stopped.url).expect(200);
    await request(application.app)
      .delete(`/api/html-previews/${stopped.id}?sessionId=s1`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    await request(application.app).get(stopped.url).expect(404);
    const moved = await start();
    context = { ...context, viewId: "view-2" };
    await request(application.app).get(moved.url).expect(404);
    const replaced = await start();
    await rename(source, `${source}.old`);
    await writeFile(source, html);
    await request(application.app).get(replaced.url).expect(409);
  });

  it("allows a cited external document's sibling assets without granting its ancestors", async () => {
    const directory = join(temporary, "external");
    await mkdir(directory);
    const path = join(directory, "cited.html");
    await writeFile(path, html);
    await writeFile(join(directory, "sibling.css"), "body { color: teal }");
    context = {
      ...context,
      messages: [
        { role: "assistant", content: [{ type: "text", text: path }] },
      ],
    };
    const grant = await start(path);
    const prefix = grant.url.slice(0, grant.url.lastIndexOf("/"));
    await request(application.app).get(`${prefix}/sibling.css`).expect(200);
    await request(application.app)
      .get(`${prefix}/..%2fprivate.txt`)
      .expect(403);
    context = { ...context, revision: 2, messages: [] };
    await request(application.app).get(grant.url).expect(403);
  });

  it("rejects non-HTML and oversized snapshots", async () => {
    const descriptor = await resources.resolve(context, "asset.js");
    await request(application.app)
      .post(`/api/resources/${descriptor.id}/interactive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "s1", html })
      .expect(400);
    const page = await resources.resolve(context, "pages/demo.html");
    await request(application.app)
      .post(`/api/resources/${page.id}/interactive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "s1", html: "界".repeat(HTML_PREVIEW_BYTES / 2) })
      .expect(413);
  });
});
