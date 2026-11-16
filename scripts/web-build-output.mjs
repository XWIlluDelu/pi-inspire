import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import {
  CURRENT_WEB_ASSETS_MANIFEST,
  currentWebBuild,
  isCompressibleStaticAsset,
  WEB_ASSET_GENERATIONS,
} from "../server/current-web-build.mjs";

const brotli = promisify(brotliCompress);
const gzipBytes = promisify(gzip);
const MIN_COMPRESSIBLE_BYTES = 1_024;

async function precompressAssets(directory, paths) {
  const encodedPaths = [];
  for (const relativePath of paths) {
    if (!isCompressibleStaticAsset(relativePath)) continue;
    const file = join(directory, relativePath);
    if ((await stat(file)).size < MIN_COMPRESSIBLE_BYTES) continue;
    const bytes = await readFile(file);
    const [br, gz] = await Promise.all([
      brotli(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
      }),
      gzipBytes(bytes),
    ]);
    for (const [suffix, encoded] of [
      [".br", br],
      [".gz", gz],
    ]) {
      if (encoded.length >= bytes.length) continue;
      await writeFile(`${file}${suffix}`, encoded);
      encodedPaths.push(`${relativePath}${suffix}`);
    }
  }
  return encodedPaths;
}

async function regularFiles(root, relativePath = "") {
  const entries = await readdir(join(root, relativePath), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function publishFile(source, destination, skipMatchingContent = false) {
  await mkdir(dirname(destination), { recursive: true });
  if (skipMatchingContent) {
    const [sourceInfo, destinationInfo] = await Promise.all([
      stat(source),
      stat(destination).catch(() => null),
    ]);
    if (destinationInfo?.isFile() && destinationInfo.size === sourceInfo.size) {
      const [sourceContent, destinationContent] = await Promise.all([
        readFile(source),
        readFile(destination),
      ]);
      if (sourceContent.equals(destinationContent)) return;
    }
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function publishManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Publish assets before switching the index and keep recent lazy chunks available. */
export async function publishWebBuild(
  stagingDirectory,
  distDirectory,
  { retainPrevious = true } = {},
) {
  const stagingRoot = join(stagingDirectory, "assets");
  const stagedAssets = await regularFiles(stagingRoot);
  const encodedAssets = await precompressAssets(stagingRoot, stagedAssets);
  const stagingAssets = [
    ...new Set([...stagedAssets, ...encodedAssets]),
  ].sort();

  for (const relativePath of stagingAssets) {
    await publishFile(
      join(stagingDirectory, "assets", relativePath),
      join(distDirectory, "assets", relativePath),
      true,
    );
  }

  const stagedFiles = await regularFiles(stagingDirectory);
  for (const relativePath of stagedFiles) {
    if (
      relativePath === "index.html" ||
      relativePath === CURRENT_WEB_ASSETS_MANIFEST ||
      relativePath.startsWith(
        `assets${process.platform === "win32" ? "\\" : "/"}`,
      )
    )
      continue;
    await publishFile(
      join(stagingDirectory, relativePath),
      join(distDirectory, relativePath),
    );
  }

  const assets = stagingAssets.map((path) => path.split(sep).join("/"));
  const generations = [assets];
  if (retainPrevious) {
    const manifest = await currentWebBuild(distDirectory)();
    for (const previous of manifest?.generations ?? []) {
      if (previous.length === assets.length &&
          previous.every((path, index) => path === assets[index])) continue;
      generations.push(previous);
      if (generations.length === WEB_ASSET_GENERATIONS) break;
    }
  }
  await publishManifest(join(distDirectory, CURRENT_WEB_ASSETS_MANIFEST), {
    version: 3,
    generations,
  });
  await publishFile(
    join(stagingDirectory, "index.html"),
    join(distDirectory, "index.html"),
  );
  const current = new Set([
    ...stagedFiles,
    ...generations.flat().map((path) => join("assets", path)),
    CURRENT_WEB_ASSETS_MANIFEST,
  ]);
  let cleanupFailures = 0;
  for (const relativePath of await regularFiles(distDirectory)) {
    if (current.has(relativePath)) continue;
    try {
      await rm(join(distDirectory, relativePath), { force: true });
    } catch {
      // Files still open on Windows remain outside the published manifest.
      cleanupFailures += 1;
    }
  }
  return { cleanupFailures };
}
