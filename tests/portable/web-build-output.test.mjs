import assert from "node:assert/strict";
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
import { afterEach, it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { buildWeb } from "../../scripts/build-web.mjs";
import { sourceBuildHash } from "../../scripts/source-build-hash.mjs";
import { publishWebBuild } from "../../scripts/web-build-output.mjs";
import { currentWebBuild } from "../../server/current-web-build.mjs";

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
    const dist = join(root, "dist");
    const manifest = await currentWebBuild(dist)();
    const script = manifest?.generations[0].find((name) => name.endsWith(".js"));
    assert.ok(script);
    return readFile(join(dist, "assets", script), "utf8");
  };
  const stamp = async () =>
    (await readFile(join(root, ".inspire-build"), "utf8")).trim();

  await buildWeb(root);
  assert.match(await compiledScript(), /before-save.*pdf-assets-first/);
  assert.notEqual(await stamp(), await sourceBuildHash(root));

  await buildWeb(root);
  assert.match(await compiledScript(), /after-save.*pdf-assets-first/);
  const compiledHash = await stamp();
  assert.equal(compiledHash, await sourceBuildHash(root));

  await put(root, assetPlugin, 'export const marker = "pdf-assets-next";\n');
  assert.notEqual(await sourceBuildHash(root), compiledHash);
});

it("keeps recent assets and encodings available and drops older generations", async () => {
  const root = await directory("inspire-web-publication-");
  const dist = join(root, "dist");
  const first = join(root, "first");
  const next = join(root, "next");
  const asset = join("nested", "chunk.js");
  const source = Buffer.from('console.log("fixture");\n'.repeat(100));
  await put(
    first,
    "index.html",
    '<script src="/assets/index-first.js"></script>',
  );
  await put(first, "assets/index-first.js", "first");
  await put(first, "obsolete.js", "old root file");
  await publishWebBuild(first, dist);
  const observe = currentWebBuild(dist);

  await put(
    next,
    "index.html",
    '<script src="/assets/index-current.js"></script>',
  );
  await put(next, "assets/index-current.js", "current");
  await put(next, join("assets", asset), source);
  await publishWebBuild(next, dist);
  const current = await observe();
  assert.deepEqual(
    [...current.assets],
    [
      "index-current.js",
      "nested/chunk.js",
      "nested/chunk.js.br",
      "nested/chunk.js.gz",
      "index-first.js",
    ],
  );
  const published = join(dist, "assets", asset);
  assert.deepEqual(await readFile(published), source);
  assert.deepEqual(
    brotliDecompressSync(await readFile(`${published}.br`)),
    source,
  );
  assert.deepEqual(gunzipSync(await readFile(`${published}.gz`)), source);
  assert.equal(await readFile(join(dist, "assets/index-first.js"), "utf8"), "first");
  await missing(join(dist, "obsolete.js"));

  for (const name of ["third", "fourth"]) {
    const staging = join(root, name);
    await put(staging, "index.html", `<script src="/assets/index-${name}.js"></script>`);
    await put(staging, `assets/index-${name}.js`, name);
    await publishWebBuild(staging, dist);
  }
  await missing(join(dist, "assets/index-first.js"));
  assert.equal((await observe()).assets.has("nested/chunk.js"), true);
});
