#!/usr/bin/env node
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { sourceBuildHash } from "./source-build-hash.mjs";
import { publishWebBuild } from "./web-build-output.mjs";

export async function buildWeb(sourceRoot, options = {}) {
  const root = await realpath(sourceRoot);
  const distDirectory = join(root, "dist");
  const sourceAssets = join(distDirectory, "assets");
  const cacheDirectory =
    options.cacheDirectory ?? defaultStaticAssetCacheDirectory(root);
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

    const stagingDirectory = await mkdtemp(
      join(tmpdir(), "inspire-web-build-"),
    );
    try {
      // A save during compilation must leave the stamp stale for the launcher.
      const inputHash = await sourceBuildHash(root);
      await build({
        root,
        build: { outDir: stagingDirectory, emptyOutDir: true },
      });
      await lease.assertOwned();
      const publication = await publishWebBuild(
        stagingDirectory,
        distDirectory,
        {
          retainOutgoing: !options.clean,
        },
      );
      if (publication.cleanupFailures > 0)
        console.warn(
          `Deferred cleanup of ${publication.cleanupFailures} old static asset(s).`,
        );
      await writeFile(join(root, ".inspire-build"), `${inputHash}\n`);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  } finally {
    await lease.release();
  }
}

if (import.meta.main)
  await buildWeb(resolve(dirname(fileURLToPath(import.meta.url)), ".."), {
    clean: process.argv.includes("--clean"),
  });
