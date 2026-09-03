import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CURRENT_WEB_ASSETS_MANIFEST,
  currentStaticAssetPaths,
} from "../server/static-asset-cache.mjs";

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

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
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

/** Publish a clean staged Vite build without invalidating the page currently
 * served from dist. New assets land first, index.html switches last, and one
 * outgoing executable generation remains during the handoff. */
export async function publishWebBuild(
  stagingDirectory,
  distDirectory,
  options = {},
) {
  const retainOutgoing = options.retainOutgoing ?? true;
  const outgoing = retainOutgoing
    ? await currentStaticAssetPaths(distDirectory)
    : [];
  const stagingAssets = await regularFiles(join(stagingDirectory, "assets"));
  const keep = new Set([...stagingAssets, ...outgoing]);

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

  const stagedIndex = await readFile(join(stagingDirectory, "index.html"));
  await publishFile(
    join(stagingDirectory, "index.html"),
    join(distDirectory, "index.html"),
  );
  await publishManifest(join(distDirectory, CURRENT_WEB_ASSETS_MANIFEST), {
    version: 1,
    indexDigest: digest(stagedIndex),
    assets: stagingAssets,
  });

  const publishedAssets = await regularFiles(join(distDirectory, "assets"));
  let cleanupFailures = 0;
  for (const relativePath of publishedAssets) {
    if (keep.has(relativePath)) continue;
    try {
      await rm(join(distDirectory, "assets", relativePath), { force: true });
    } catch (error) {
      if (!retainOutgoing) throw error;
      // An old Host may still have this immutable file open on Windows. It is
      // harmless to serve and the next publication retries its removal.
      cleanupFailures += 1;
    }
  }
  if (!retainOutgoing) {
    const keepPublishedFiles = new Set([
      ...stagedFiles,
      CURRENT_WEB_ASSETS_MANIFEST,
    ]);
    for (const relativePath of await regularFiles(distDirectory)) {
      if (keepPublishedFiles.has(relativePath)) continue;
      await rm(join(distDirectory, relativePath), { force: true });
    }
  }
  return {
    currentAssets: stagingAssets.length,
    retainedOutgoingAssets: outgoing.length,
    cleanupFailures,
  };
}
