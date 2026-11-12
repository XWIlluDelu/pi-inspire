import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultStaticAssetCacheDirectory,
  prepareStaticAssetCache,
} from "../../server/static-asset-cache.mjs";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-static-assets-"));
  temporaryDirectories.push(root);
  const dist = join(root, "dist");
  const source = join(dist, "assets");
  const cache = join(root, "cache");
  await mkdir(source, { recursive: true });
  return { dist, source, cache };
}

async function replaceSource(
  source: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(source, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("static asset generation cache", () => {
  it("isolates cached generations between installations", () => {
    const options = {
      platform: "linux" as const,
      environment: { XDG_CACHE_HOME: "/cache" },
      home: "/home/test",
    };
    const first = defaultStaticAssetCacheDirectory("/srv/inspire", options);
    expect(defaultStaticAssetCacheDirectory("/srv/other", options)).not.toBe(
      first,
    );
  });

  it("serves current and retained browser assets until the outgoing generation expires", async () => {
    const { dist, source, cache } = await fixture();
    const now = Date.UTC(2026, 8, 4, 2);
    const retentionMs = 1_000;
    const html = "<title>INSΠRE</title>";
    const script = 'console.log("current");\n'.repeat(100);
    const css = ".fixture { display: block; }\n".repeat(100);
    const reader = {
      "pdf.worker-first.mjs": "worker",
      "pdfjs-first/cmaps/Adobe-Japan1.bcmap": "cmap",
      "pdfjs-first/standard_fonts/FoxitSerif.pfb": "font",
      "pdfjs-first/standard_fonts/LiberationSans-Regular.ttf": "truetype",
      "pdfjs-first/wasm/openjpeg_nowasm_fallback.js": "decoder",
    };
    await Promise.all([
      writeFile(join(dist, "index.html"), html),
      writeFile(join(dist, "theme-init.js"), "theme"),
      replaceSource(source, {
        ...reader,
        "app-hashed.js": "stale duplicate",
        "old-hashed.css": css,
        "old-hashed.css.gz": gzipSync(css),
      }),
    ]);
    const first = await prepareStaticAssetCache(source, cache, {
      now,
      retentionMs,
    });

    await replaceSource(source, {
      "app-hashed.js": script,
      "app-hashed.js.br": brotliCompressSync(script),
      "app-hashed.js.gz": gzipSync(script),
    });
    // A long-lived generation starts aging when it stops being current.
    const next = await prepareStaticAssetCache(source, cache, {
      now: now + 10_000,
      retentionMs,
    });
    const host = await hostApiFixture({
      distDir: dist,
      staticAssetCacheDirs: next.generationDirectories.slice(1),
    });
    const get = (path: string, init?: RequestInit) =>
      fetch(host.baseUrl + path, init);
    const asset = "/assets/app-hashed.js";
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

      const old = await get("/assets/old-hashed.css", {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(old.status).toBe(200);
      expect(old.headers.get("content-type")).toMatch(/^text\/css/);
      expect(old.headers.get("content-encoding")).toBe("gzip");
      expect(old.headers.get("cache-control")).toContain("immutable");
      expect(await old.text()).toBe(css);
      for (const [path, bytes] of Object.entries(reader)) {
        const response = await get(`/assets/${path}`);
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).toBe(bytes);
      }
      await prepareStaticAssetCache(source, cache, {
        now: now + 12_000,
        retentionMs,
      });
      const outgoing = first.generationDirectories[0]!;
      await expect(stat(outgoing)).rejects.toMatchObject({ code: "ENOENT" });
      const expired = await get("/assets/old-hashed.css");
      expect(expired.status).toBe(404);
      expect(expired.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(expired.headers.get("cache-control")).toBe("no-store");
      await expired.body?.cancel();

      const theme = await get("/theme-init.js");
      expect(theme.headers.get("cache-control")).toContain("max-age=0");
      expect(theme.headers.get("cache-control")).not.toContain("immutable");
      expect(await theme.text()).toBe("theme");
      for (const path of [`/?token=${token}`, "/deep/route"]) {
        const shell = await get(path);
        expect(shell.headers.get("cache-control")).toBe("no-cache");
        expect(await shell.text()).toBe(html);
      }
      const unknownApi = await get("/api/not-a-route", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(unknownApi.status).toBe(404);
      expect(await unknownApi.json()).toEqual({ error: "API route not found" });
    } finally {
      await closeHostApiFixture(host);
    }
  });

  it("preserves the newest executable generation within the stale byte budget", async () => {
    const { source, cache } = await fixture();
    const now = Date.UTC(2026, 8, 4, 2);
    await replaceSource(source, {
      "old-entry.js": "123456\n",
      "old-shared.js": "123456\n",
    });
    const oldest = await prepareStaticAssetCache(source, cache, { now });

    await replaceSource(source, {
      "newer-entry.js": "1234567\n",
      "image.png": Buffer.alloc(1_024),
    });
    const newer = await prepareStaticAssetCache(source, cache, {
      now: now + 100,
    });

    await replaceSource(source, { "current.js": "current\n" });
    const current = await prepareStaticAssetCache(source, cache, {
      now: now + 200,
      maxStaleBytes: Buffer.byteLength("1234567\n123456\n"),
    });

    expect(current.generationDirectories).toContain(
      join(cache, "generations", newer.currentGeneration),
    );
    await expect(
      readFile(
        join(cache, "generations", newer.currentGeneration, "newer-entry.js"),
        "utf8",
      ),
    ).resolves.toBe("1234567\n");
    await expect(
      stat(join(cache, "generations", oldest.currentGeneration)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
