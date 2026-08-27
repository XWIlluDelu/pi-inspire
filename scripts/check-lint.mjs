import { execFileSync } from "node:child_process";
import { npmInvocation } from "../server/npm-command.mjs";

const invocation = npmInvocation([
  "exec",
  "--",
  "biome",
  "lint",
  "--error-on-warnings",
]);
execFileSync(invocation.command, invocation.args, {
  env: invocation.environment,
  stdio: "inherit",
});
execFileSync(process.execPath, ["scripts/check-import-boundaries.mjs"], {
  stdio: "inherit",
});
