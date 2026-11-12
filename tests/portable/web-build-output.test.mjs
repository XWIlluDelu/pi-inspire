import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { buildWeb } from "../../scripts/build-web.mjs";
import { sourceBuildHash } from "../../scripts/source-build-hash.mjs";
import { publishWebBuild } from "../../scripts/web-build-output.mjs";
import {
  currentStaticAssetPaths,
  prepareStaticAssetCache,
} from "../../server/static-asset-cache.mjs";

const temporaryDirectories = [];

async function directory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function put(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function missing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("stamps the inputs actually compiled and detects asset plugin edits", async () => {
  const root = await directory("inspire-build-save-");
  const cacheDirectory = join(root, "cache");
  const afterSave = 'console.log("after-save", __ASSET_MARKER__);\n';
  const assetPlugin = "scripts/vite-pdf-assets.ts";
  await put(root, "package.json", '{"type":"module"}\n');
  await put(
    root,
    "index.html",
    '<script type="module" src="/src/main.js"></script>\n',
  );
  await put(
    root,
    "src/main.js",
    'console.log("before-save", __ASSET_MARKER__);\n',
  );
  await put(root, assetPlugin, 'export const marker = "pdf-assets-first";\n');
  await put(
    root,
    "vite.config.ts",
    `import { writeFile } from "node:fs/promises";
import { marker } from "./scripts/vite-pdf-assets";
export default {
  logLevel: "silent",
  define: { __ASSET_MARKER__: JSON.stringify(marker) },
  plugins: [{
    name: "save-source-after-compilation",
    async writeBundle() {
      await writeFile(${JSON.stringify(join(root, "src/main.js"))}, ${JSON.stringify(afterSave)});
    },
  }],
};\n`,
  );
  const compiledScript = async () => {
    const assets = join(root, "dist", "assets");
    const script = (await readdir(assets)).find((name) => name.endsWith(".js"));
    assert.ok(script);
    return readFile(join(assets, script), "utf8");
  };
  const stamp = async () =>
    (await readFile(join(root, ".inspire-build"), "utf8")).trim();

  await buildWeb(root, { cacheDirectory });
  assert.match(await compiledScript(), /before-save.*pdf-assets-first/);
  assert.notEqual(await stamp(), await sourceBuildHash(root));

  await buildWeb(root, { cacheDirectory, clean: true });
  assert.match(await compiledScript(), /after-save.*pdf-assets-first/);
  const compiledHash = await stamp();
  assert.equal(compiledHash, await sourceBuildHash(root));

  await put(root, assetPlugin, 'export const marker = "pdf-assets-next";\n');
  assert.notEqual(await sourceBuildHash(root), compiledHash);
});

it("keeps one outgoing executable generation and its encodings until the next publication", async () => {
  const root = await directory("inspire-web-publication-");
  const dist = join(root, "dist");
  const cache = join(root, "cache");
  const first = join(root, "first");
  const second = join(root, "second");
  const release = join(root, "release");
  const asset = join("nested", "main-first.js");
  const source = Buffer.from('console.log("fixture");\n'.repeat(100));

  await put(dist, "assets/main-old.js", "old main");
  await put(dist, "assets/old.png", "old image");
  await put(first, "index.html", "first index");
  await put(first, "theme-init.js", "first theme");
  await put(first, join("assets", asset), source);
  await publishWebBuild(first, dist);

  assert.equal(await readFile(join(dist, "index.html"), "utf8"), "first index");
  assert.equal(
    await readFile(join(dist, "theme-init.js"), "utf8"),
    "first theme",
  );
  assert.equal(
    await readFile(join(dist, "assets/main-old.js"), "utf8"),
    "old main",
  );
  await missing(join(dist, "assets/old.png"));

  const cached = await prepareStaticAssetCache(join(dist, "assets"), cache, {
    assetPaths: await currentStaticAssetPaths(dist),
  });
  await missing(join(cached.generationDirectories[0], "main-old.js"));
  await put(second, "index.html", "second index");
  await put(second, "assets/main-second.js", "second main");
  await publishWebBuild(second, dist);

  assert.equal(
    await readFile(join(dist, "index.html"), "utf8"),
    "second index",
  );
  await missing(join(dist, "assets/main-old.js"));
  for (const dir of [join(dist, "assets"), cached.generationDirectories[0]]) {
    assert.deepEqual(await readFile(join(dir, asset)), source);
    assert.deepEqual(
      brotliDecompressSync(await readFile(join(dir, `${asset}.br`))),
      source,
    );
    assert.deepEqual(
      gunzipSync(await readFile(join(dir, `${asset}.gz`))),
      source,
    );
  }

  await put(release, "index.html", "release index");
  await put(release, "assets/main-release.js", "release main");
  await publishWebBuild(release, dist, { retainOutgoing: false });
  await missing(join(dist, "assets/main-second.js"));
  assert.equal(
    await readFile(join(dist, "assets/main-release.js"), "utf8"),
    "release main",
  );
});
