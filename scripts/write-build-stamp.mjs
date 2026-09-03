import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceBuildHash } from "./source-build-hash.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The source-checkout marker never ships in the npm distribution: installed
 * packages execute their prebuilt runtime and have no source build to validate. */
export async function writeBuildStamp(root = defaultRoot) {
  await writeFile(
    join(root, ".inspire-build"),
    `${await sourceBuildHash(root)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await writeBuildStamp();
