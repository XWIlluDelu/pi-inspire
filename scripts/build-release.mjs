import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const build = resolve(root, "build");

await rm(build, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    resolve(root, "tsconfig.release.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
