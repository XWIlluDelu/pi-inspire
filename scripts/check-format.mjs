import { execFileSync } from "node:child_process";
import { npmInvocation } from "../server/npm-command.mjs";

const invocation = npmInvocation(["exec", "--", "biome", "format"]);
execFileSync(invocation.command, invocation.args, {
  env: invocation.environment,
  stdio: "inherit",
});
