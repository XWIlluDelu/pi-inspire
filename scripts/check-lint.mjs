import { execFileSync } from "node:child_process";

execFileSync("npx", ["biome", "lint", "--error-on-warnings"], {
  stdio: "inherit",
});
execFileSync(process.execPath, ["scripts/check-import-boundaries.mjs"], {
  stdio: "inherit",
});
