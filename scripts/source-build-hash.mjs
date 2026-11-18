import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildInputs = [
  "src",
  "shared",
  "public",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.web.json",
  "tsconfig.server.json",
  "package.json",
  "package-lock.json",
  "scripts/build-web.mjs",
  "scripts/web-build-output.mjs",
  "server/current-web-build.mjs",
  "scripts/vite-license-notices.ts",
  "scripts/vite-pdf-assets.ts",
  "scripts/licenses",
];

async function filesUnder(root, relativePath, entry) {
  try {
    entry ??= await lstat(join(root, relativePath));
    if (entry.isFile()) return [relativePath];
    if (!entry.isDirectory()) return [];
    const children = await readdir(join(root, relativePath), {
      withFileTypes: true,
    });
    return (
      await Promise.all(
        children.map((child) =>
          filesUnder(root, join(relativePath, child.name), child),
        ),
      )
    ).flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Fingerprint the source and build inputs that can alter the Vite client.
 * The source launcher and ordinary build command share this implementation so
 * a successful source build never triggers a redundant client rebuild. */
export async function sourceBuildHash(root = defaultRoot) {
  const files = (
    await Promise.all(buildInputs.map((input) => filesUnder(root, input)))
  )
    .flat()
    .sort();
  const hash = createHash("sha256");
  for (const relativePath of files) {
    const contentHash = createHash("sha256")
      .update(await readFile(join(root, relativePath)))
      .digest("hex");
    hash.update(`${relativePath} ${contentHash}\n`);
  }
  return hash.digest("hex");
}
