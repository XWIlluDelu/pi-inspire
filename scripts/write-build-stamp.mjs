import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceBuildHash } from "./source-build-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The source-checkout marker must not ship in the npm distribution: installed
// packages execute their prebuilt runtime and have no source build to validate.
await writeFile(
  join(root, ".inspire-build"),
  `${await sourceBuildHash(root)}\n`,
);
