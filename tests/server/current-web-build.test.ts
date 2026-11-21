import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import request from "supertest";
import { expect, it } from "vitest";
import { CURRENT_WEB_ASSETS_MANIFEST } from "../../server/current-web-build.mjs";
import { closeHostApiFixture, hostApiFixture } from "./fixtures/host-api.js";

it("serves only published assets with validators, ranges and encodings", async () => {
  const dist = await mkdtemp(join(tmpdir(), "inspire-assets-"));
  const source = join(dist, "assets");
  const asset = "/assets/index-current.js";
  const script = 'console.log("current");\n'.repeat(100);
  await mkdir(source);
  await Promise.all([
    writeFile(join(source, "index-current.js"), script),
    writeFile(join(source, "index-current.js.br"), brotliCompressSync(script)),
    writeFile(join(source, "index-current.js.gz"), gzipSync(script)),
    writeFile(join(source, "old.js"), "outgoing but still open on disk"),
    writeFile(join(dist, "index.html"), "<title>Inspire</title>"),
    writeFile(
      join(dist, CURRENT_WEB_ASSETS_MANIFEST),
      JSON.stringify({
        version: 3,
        generations: [["index-current.js", "index-current.js.br", "index-current.js.gz"]],
      }),
    ),
  ]);
  const host = await hostApiFixture({ distDir: dist });
  const get = (path: string, init?: RequestInit) =>
    fetch(host.baseUrl + path, init);
  try {
    const br = await get(`${asset}?v=1`, {
      headers: { "Accept-Encoding": "br, gzip" },
    });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(br.headers.get("content-encoding")).toBe("br");
    const cacheControl = br.headers.get("cache-control");
    expect(cacheControl).toContain("max-age=31536000");
    expect(cacheControl).toContain("immutable");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(await br.text()).toBe(script);

    const head = await get(asset, {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip, br;q=0.5" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect(head.headers.get("etag")).not.toBe(br.headers.get("etag"));
    await request(host.application.server)
      .get(asset)
      .set("Accept-Encoding", "br")
      .set("If-None-Match", br.headers.get("etag")!)
      .expect(304)
      .expect("Vary", "Accept-Encoding");

    const identity = await get(asset, {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=0" },
    });
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toBe("Accept-Encoding");
    expect(await identity.text()).toBe(script);
    const range = await get(asset, {
      headers: { "Accept-Encoding": "br, gzip", Range: "bytes=0-6" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-encoding")).toBeNull();
    expect(range.headers.get("content-range")).toBe(
      `bytes 0-6/${Buffer.byteLength(script)}`,
    );
    expect(await range.text()).toBe(script.slice(0, 7));

    expect((await get("/assets/old.js")).status).toBe(404);
    expect((await get("/assets/index-current.js.br")).status).toBe(404);
    expect(await (await get("/")).text()).toBe("<title>Inspire</title>");
  } finally {
    await closeHostApiFixture(host);
    await rm(dist, { recursive: true, force: true });
  }
});
