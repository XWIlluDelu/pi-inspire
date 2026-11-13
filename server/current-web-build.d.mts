export const CURRENT_WEB_ASSETS_MANIFEST: string;
export function isCompressibleStaticAsset(path: string): boolean;
export function currentWebBuild(
  dist: string,
): () => Promise<{
  buildId: string;
  indexDigest: string;
  assets: ReadonlySet<string>;
} | null>;
