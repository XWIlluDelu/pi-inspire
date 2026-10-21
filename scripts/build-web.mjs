#!/usr/bin/env node
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { acquireFileLock } from "../server/file-lock.mjs";
import {
  currentStaticAssetPaths,
  defaultStaticAssetCacheDirectory,
  prepareStaticAssetCache,
} from "../server/static-asset-cache.mjs";
import { publishWebBuild } from "./web-build-output.mjs";
import { writeBuildStamp } from "./write-build-stamp.mjs";

const root = await realpath(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const distDirectory = join(root, "dist");
const sourceAssets = join(distDirectory, "assets");
const cacheDirectory = defaultStaticAssetCacheDirectory(root);
const clean = process.argv.includes("--clean");
const lease = await acquireFileLock(join(cacheDirectory, "web-build.lock"), {
  waitMs: 10 * 60 * 1_000,
  label: "web build",
});

try {
  const hasOutgoingBuild = await stat(sourceAssets).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (hasOutgoingBuild) {
    try {
      const cache = await prepareStaticAssetCache(
        sourceAssets,
        cacheDirectory,
        { assetPaths: await currentStaticAssetPaths(distDirectory) },
      );
      if (cache.pruneFailures > 0)
        console.warn(
          `Deferred cleanup of ${cache.pruneFailures} cached asset generation(s).`,
        );
    } catch (error) {
      // Preserving an old browser generation must not make a valid new build
      // unavailable. The Host retries the cache on its next start.
      console.error(
        "Unable to preserve prior static assets:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const stagingDirectory = await mkdtemp(join(tmpdir(), "inspire-web-build-"));
  try {
    await build({
      root,
      build: { outDir: stagingDirectory, emptyOutDir: true },
    });
    await lease.assertOwned();
    const publication = await publishWebBuild(stagingDirectory, distDirectory, {
      retainOutgoing: !clean,
    });
    if (publication.cleanupFailures > 0)
      console.warn(
        `Deferred cleanup of ${publication.cleanupFailures} old static asset(s).`,
      );
    await writeBuildStamp(root);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
} finally {
  await lease.release();
}
