export const CURRENT_WEB_ASSETS_MANIFEST: string;
export const WEB_ASSET_GENERATIONS: number;
export function isCompressibleStaticAsset(path: string): boolean;
export function currentWebBuild(
  dist: string,
): () => Promise<{
  generations: readonly (readonly string[])[];
  assets: ReadonlySet<string>;
} | null>;
