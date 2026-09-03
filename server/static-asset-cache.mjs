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
import { dirname, extname, isAbsolute, join } from "node:path";
import { inspireCacheDirectory } from "./platform-paths.mjs";

const CACHEABLE_EXTENSIONS = new Set([".css", ".js", ".wasm"]);
export const CURRENT_WEB_ASSETS_MANIFEST = ".inspire-current-assets.json";
const MANIFEST_VERSION = 1;
const STATIC_ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_STALE_STATIC_ASSET_BYTES = 64 * 1024 * 1024;
const GENERATION_ID = /^[a-f0-9]{64}$/u;

function rootKey(root) {
  return createHash("sha256").update(root).digest("hex");
}

export function defaultStaticAssetCacheDirectory(root, pathOptions) {
  return join(
    inspireCacheDirectory(pathOptions),
    "static-assets",
    rootKey(root),
  );
}

function safeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/u).includes("..")
  );
}

async function cacheableFiles(root, relativePath = "") {
  const entries = await readdir(join(root, relativePath), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await cacheableFiles(root, child)));
    else if (
      entry.isFile() &&
      CACHEABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      const info = await stat(join(root, child));
      files.push({ relativePath: child, size: info.size });
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function selectedCacheableFiles(root, relativePaths) {
  const selected = [...new Set(relativePaths)].sort();
  if (
    !selected.every(
      (path) =>
        safeRelativePath(path) &&
        CACHEABLE_EXTENSIONS.has(extname(path).toLowerCase()),
    )
  )
    throw new Error("Static asset selection contains an invalid path");
  return Promise.all(
    selected.map(async (relativePath) => {
      const info = await stat(join(root, relativePath));
      if (!info.isFile()) throw new Error(`Static asset is not a file: ${relativePath}`);
      return { relativePath, size: info.size };
    }),
  );
}

function contentDigest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function currentStaticAssetPaths(distDirectory) {
  try {
    const [index, manifest] = await Promise.all([
      readFile(join(distDirectory, "index.html")),
      readFile(join(distDirectory, CURRENT_WEB_ASSETS_MANIFEST), "utf8"),
    ]);
    const parsed = JSON.parse(manifest);
    if (
      parsed?.version === 1 &&
      parsed.indexDigest === contentDigest(index) &&
      Array.isArray(parsed.assets) &&
      parsed.assets.every(safeRelativePath)
    )
      return parsed.assets.filter((path) =>
        CACHEABLE_EXTENSIONS.has(extname(path).toLowerCase()),
      );
  } catch {
    // Builds created before the manifest existed had a clean assets directory,
    // so scanning it is the correct migration fallback.
  }
  try {
    return (await cacheableFiles(join(distDirectory, "assets"))).map(
      (file) => file.relativePath,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function generationId(files) {
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(`${file.relativePath}\0${file.size}\n`);
  return hash.digest("hex");
}

function validGeneration(value) {
  if (!value || typeof value !== "object") return false;
  return (
    GENERATION_ID.test(value.id) &&
    Number.isFinite(value.lastSeen) &&
    value.lastSeen >= 0 &&
    Number.isFinite(value.bytes) &&
    value.bytes >= 0
  );
}

async function readGenerations(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (parsed?.version !== MANIFEST_VERSION || !Array.isArray(parsed.generations))
      return [];
    return parsed.generations.filter(validGeneration);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeGenerations(manifestPath, generations) {
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: MANIFEST_VERSION, generations })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureGenerationDirectory(sourceAssets, destination, files) {
  try {
    if ((await stat(destination)).isDirectory()) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) {
      const target = join(temporary, file.relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(sourceAssets, file.relativePath), target);
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      const winner = await stat(destination).catch(() => null);
      if (!winner?.isDirectory()) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pruneGenerationDirectories(generationsRoot, keep) {
  let removedGenerations = 0;
  let pruneFailures = 0;
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && keep.has(entry.name)) continue;
    try {
      await rm(join(generationsRoot, entry.name), {
        recursive: true,
        force: true,
      });
      removedGenerations += 1;
    } catch {
      // A locked stale file, especially on Windows, must not disable every
      // otherwise valid retained generation. A later startup retries cleanup.
      pruneFailures += 1;
    }
  }
  return { removedGenerations, pruneFailures };
}

/**
 * Snapshot one complete Vite generation for already-open browser tabs. The
 * active generation is always kept; prior generations expire as indivisible
 * units by both age and a fixed byte budget.
 */
export async function prepareStaticAssetCache(
  sourceAssets,
  cacheDirectory,
  options = {},
) {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? STATIC_ASSET_RETENTION_MS;
  const maxStaleBytes =
    options.maxStaleBytes ?? MAX_STALE_STATIC_ASSET_BYTES;
  if (retentionMs < 0 || maxStaleBytes < 0)
    throw new Error("Static asset retention limits must not be negative");

  const files = options.assetPaths
    ? await selectedCacheableFiles(sourceAssets, options.assetPaths)
    : await cacheableFiles(sourceAssets);
  const current = {
    id: generationId(files),
    lastSeen: now,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
  const generationsRoot = join(cacheDirectory, "generations");
  const manifestPath = join(cacheDirectory, "generations.json");
  await mkdir(generationsRoot, { recursive: true, mode: 0o700 });
  await ensureGenerationDirectory(
    sourceAssets,
    join(generationsRoot, current.id),
    files,
  );

  const previous = await readGenerations(manifestPath);
  // Retention begins when a generation stops being current, not when its Host
  // last happened to start. This also covers package replacement after a long
  // uninterrupted uptime.
  if (previous[0] && previous[0].id !== current.id)
    previous[0] = { ...previous[0], lastSeen: now };
  const eligible = previous
    .filter(
      (generation) =>
        generation.id !== current.id &&
        generation.lastSeen >= now - retentionMs,
    )
    .sort(
      (left, right) =>
        right.lastSeen - left.lastSeen || left.id.localeCompare(right.id),
    );
  const retained = [current];
  let staleBytes = 0;
  for (const generation of eligible) {
    if (staleBytes + generation.bytes > maxStaleBytes) break;
    retained.push(generation);
    staleBytes += generation.bytes;
  }

  await writeGenerations(manifestPath, retained);
  const keep = new Set(retained.map((generation) => generation.id));
  const pruning = await pruneGenerationDirectories(generationsRoot, keep);
  return {
    currentGeneration: current.id,
    generationDirectories: retained.map((generation) =>
      join(generationsRoot, generation.id),
    ),
    staleGenerations: retained.length - 1,
    staleBytes,
    ...pruning,
  };
}
