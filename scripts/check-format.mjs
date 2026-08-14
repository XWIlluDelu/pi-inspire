import { execFileSync } from "node:child_process";

execFileSync("npx", ["biome", "format"], {
  stdio: "inherit",
});
