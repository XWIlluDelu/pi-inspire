#!/usr/bin/env node
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { acquireFileLock } from "../server/file-lock.mjs";
import { sourceBuildHash } from "./source-build-hash.mjs";
import { publishWebBuild } from "./web-build-output.mjs";

export async function buildWeb(sourceRoot, { retainPrevious = true } = {}) {
  const root = await realpath(sourceRoot);
  const distDirectory = join(root, "dist");
  const lease = await acquireFileLock(join(root, ".inspire-web-build.lock"), {
    waitMs: 10 * 60 * 1_000,
    label: "web build",
  });

  try {
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
        { retainPrevious },
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
    retainPrevious: !process.argv.includes("--clean"),
  });
