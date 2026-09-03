interface StaticAssetCachePathOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  temporary?: string;
}

interface StaticAssetCacheOptions {
  now?: number;
  retentionMs?: number;
  maxStaleBytes?: number;
  assetPaths?: readonly string[];
}

interface StaticAssetCacheResult {
  currentGeneration: string;
  generationDirectories: string[];
  staleGenerations: number;
  staleBytes: number;
  removedGenerations: number;
  pruneFailures: number;
}

export const CURRENT_WEB_ASSETS_MANIFEST: string;

export function defaultStaticAssetCacheDirectory(
  root: string,
  pathOptions?: StaticAssetCachePathOptions,
): string;

export function currentStaticAssetPaths(
  distDirectory: string,
): Promise<string[]>;

export function prepareStaticAssetCache(
  sourceAssets: string,
  cacheDirectory: string,
  options?: StaticAssetCacheOptions,
): Promise<StaticAssetCacheResult>;
