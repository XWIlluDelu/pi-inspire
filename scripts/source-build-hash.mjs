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
  "package-lock.json",
];

async function filesUnder(root, relativePath) {
  const path = join(root, relativePath);
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return [];
    throw error;
  }
  if (entry.isFile()) return [relativePath];
  if (!entry.isDirectory()) return [];
  const children = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    children.map((child) => filesUnder(root, join(relativePath, child.name))),
  );
  return nested.flat();
}

/** Fingerprints exactly the source inputs that can alter the Vite client.
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

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.stdout.write(`${await sourceBuildHash()}\n`);
