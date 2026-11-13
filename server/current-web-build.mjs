import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const CURRENT_WEB_ASSETS_MANIFEST = ".inspire-current-assets.json";

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
      if (
        data?.version !== 2 ||
        !/^[a-f0-9]{64}$/u.test(data.indexDigest) ||
        !safePath(data.buildId) ||
        !Array.isArray(data.assets) ||
        !data.assets.every(safePath) ||
        (data.buildId !== data.indexDigest && !data.assets.includes(data.buildId))
      )
        return null;
      const manifest = {
        buildId: data.buildId,
        indexDigest: data.indexDigest,
        assets: new Set(data.assets),
      };
      last = { generation, manifest };
      return manifest;
    } catch {
      return null;
    }
  };
}
