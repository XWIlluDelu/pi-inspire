import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const CURRENT_WEB_ASSETS_MANIFEST = ".inspire-current-assets.json";
export const WEB_ASSET_GENERATIONS = 3;

export function isCompressibleStaticAsset(path) {
  return /\.(?:m?js|css)$/iu.test(path);
}

const safePath = (path) =>
  typeof path === "string" &&
  path.length <= 1024 &&
  path.split("/").every((part) => /^[\w@+.-]+$/u.test(part) && !part.startsWith("."));

export function currentWebBuild(dist) {
  const path = join(dist, CURRENT_WEB_ASSETS_MANIFEST);
  let last;
  return async () => {
    try {
      const info = await stat(path);
      const generation = `${info.ino}:${info.mtimeMs}:${info.size}`;
      if (last?.generation === generation) return last.manifest;
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return null;
      const data = JSON.parse(await readFile(path, "utf8"));
      const generations =
        data?.version === 2
          ? [data.assets]
          : data?.version === 3
            ? data.generations
            : null;
      if (
        !Array.isArray(generations) ||
        generations.length === 0 ||
        generations.length > WEB_ASSET_GENERATIONS ||
        !generations.every((assets) => Array.isArray(assets) && assets.every(safePath))
      )
        return null;
      const manifest = {
        generations,
        assets: new Set(generations.flat()),
      };
      last = { generation, manifest };
      return manifest;
    } catch {
      return null;
    }
  };
}
