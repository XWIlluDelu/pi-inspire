import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceContext } from "../../server/resources.js";
import { HTML_PREVIEW_BYTES } from "../../shared/html-preview.js";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("interactive HTML capabilities", () => {
  let temporary: string;
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  let context: ResourceContext & { messages: unknown[]; loadMessages?: never };
  const html = "<h1>Loaded snapshot</h1><script>window.ready = true</script>";
  let source: string;

  beforeEach(async () => {
    fixture = await hostApiFixture();
    temporary = fixture.temporary;
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
    vi.spyOn(fixture.runtime, "resourceContext").mockImplementation(
      async () => context,
    );
  });
  afterEach(() => closeHostApiFixture(fixture));

  async function start(reference = "pages/demo.html", snapshot = html) {
    const descriptor = await fixture.resources.resolve(context, reference);
    const response = await fixture.localRequest
      .post(`/api/resources/${descriptor.id}/interactive`)
      .send({ sessionId: context.sessionId, html: snapshot });
    expect(response.status).toBe(200);
    return { ...(response.body as { id: string; url: string }), descriptor };
  }

  it("requires explicit authenticated creation and runs the loaded snapshot under its own policy", async () => {
    const descriptor = await fixture.resources.resolve(
      context,
      "pages/demo.html",
    );
    await request(fixture.application.server)
      .post(`/api/resources/${descriptor.id}/interactive`)
      .send({ sessionId: "s1", html })
      .expect(401);
    const grant = await start();
    await writeFile(source, "<h1>Later edit</h1>");
    const served = await request(fixture.application.server)
      .get(grant.url)
      .expect(200);
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
    const ordinary = await fixture.localRequest
      .get(`/api/resources/${descriptor.id}/content?sessionId=s1`)
      .expect(200);
    expect(ordinary.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(ordinary.headers["content-security-policy"]).not.toContain(
      "unsafe-eval",
    );
    await request(fixture.application.server)
      .get("/api/snapshot")
      .set("Origin", "null")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("serves relative modules and ranged media with opaque-origin CORS, not Host credentials", async () => {
    const grant = await start();
    const prefix = grant.url.split("/pages/")[0]!;
    const module = await request(fixture.application.server)
      .get(`${prefix}/asset.js`)
      .set("Origin", "null")
      .expect(200);
    expect(module.text).toContain("export const value");
    expect(module.headers["content-type"]).toMatch(/javascript/);
    expect(module.headers["access-control-allow-origin"]).toBe("*");
    expect(module.headers["access-control-allow-credentials"]).toBeUndefined();
    const media = await request(fixture.application.server)
      .get(`${prefix}/pages/media.mp4`)
      .set("Range", "bytes=2-4")
      .expect(206);
    expect(media.headers["content-range"]).toBe("bytes 2-4/10");
    expect(media.body.toString()).toBe("234");
    await request(fixture.application.server)
      .get(`${prefix}/pages/media.mp4`)
      .set("Range", "bytes=100-")
      .expect(416);
  });

  it("confines local assets to the granted root, including symlink targets", async () => {
    const grant = await start();
    const prefix = grant.url.split("/pages/")[0]!;
    await request(fixture.application.server)
      .get(`${prefix}/..%2fprivate.txt`)
      .expect(403);
    if (process.platform !== "win32") {
      await symlink(
        join(temporary, "private.txt"),
        join(context.cwd, "escape.txt"),
      );
      await request(fixture.application.server)
        .get(`${prefix}/escape.txt`)
        .expect(403);
    }
    await request(fixture.application.server)
      .get(`${prefix}/missing.js`)
      .expect(404);
  });

  it("denies a case-distinct sibling on an actually case-sensitive native directory", async (test) => {
    const parent = join(temporary, "native-case-boundary");
    await mkdir(parent);
    if (process.platform === "win32") {
      const fsutil = process.env.SystemRoot
        ? join(process.env.SystemRoot, "System32", "fsutil.exe")
        : "fsutil.exe";
      try {
        // This flag applies only to the empty owned fixture, never a user root.
        await promisify(execFileCallback)(
          fsutil,
          ["file", "setCaseSensitiveInfo", parent, "enable"],
          { windowsHide: true, timeout: 10_000 },
        );
      } catch {
        return test.skip();
      }
    }
    const project = join(parent, "Project");
    const sibling = join(parent, "project");
    await mkdir(project);
    if (
      await stat(sibling).then(
        () => true,
        () => false,
      )
    )
      return test.skip();
    await mkdir(sibling);
    await writeFile(join(project, "index.html"), html);
    await writeFile(join(sibling, "private.txt"), "outside fixture bytes");
    context = { ...context, cwd: project };
    const grant = await start("index.html");
    const prefix = grant.url.slice(0, grant.url.lastIndexOf("/"));
    await request(fixture.application.server)
      .get(
        prefix +
          "/" +
          encodeURIComponent(["..", "project", "private.txt"].join(sep)),
      )
      .set("Origin", "null")
      .expect(403);
  });

  it("revokes on stop and refuses a retired branch view or replaced entry file", async () => {
    const stopped = await start();
    await fixture.localRequest
      .delete(`/api/html-previews/${stopped.id}?sessionId=other`)
      .expect(204);
    await request(fixture.application.server).get(stopped.url).expect(200);
    await fixture.localRequest
      .delete(`/api/html-previews/${stopped.id}?sessionId=s1`)
      .expect(204);
    await request(fixture.application.server).get(stopped.url).expect(404);
    const moved = await start();
    context = { ...context, viewId: "view-2" };
    await request(fixture.application.server).get(moved.url).expect(404);
    const replaced = await start();
    await rename(source, `${source}.old`);
    await writeFile(source, html);
    await request(fixture.application.server).get(replaced.url).expect(409);
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
    await request(fixture.application.server)
      .get(`${prefix}/sibling.css`)
      .expect(200);
    await request(fixture.application.server)
      .get(`${prefix}/..%2fprivate.txt`)
      .expect(403);
    context = { ...context, revision: 2, messages: [] };
    await request(fixture.application.server).get(grant.url).expect(403);
  });

  it("rejects non-HTML and oversized snapshots", async () => {
    const descriptor = await fixture.resources.resolve(context, "asset.js");
    await fixture.localRequest
      .post(`/api/resources/${descriptor.id}/interactive`)
      .send({ sessionId: "s1", html })
      .expect(400);
    const page = await fixture.resources.resolve(context, "pages/demo.html");
    await fixture.localRequest
      .post(`/api/resources/${page.id}/interactive`)
      .send({ sessionId: "s1", html: "界".repeat(HTML_PREVIEW_BYTES / 2) })
      .expect(413);
  });
});
