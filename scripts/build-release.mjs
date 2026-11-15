import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
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
await mkdir(resolve(build, "server"), { recursive: true });
for (const supportModule of [
  "file-lock.mjs",
  "instance-state.mjs",
  "instance-control.mjs",
  "launcher-restart.mjs",
  "restart-submission.mjs",
  "npm-command.mjs",
  "platform-paths.mjs",
  "platform-environment.mjs",
  "process-tree.mjs",
  "pi-processes.mjs",
  "current-web-build.mjs",
  "user-environment.mjs",
]) {
  await cp(
    resolve(root, "server", supportModule),
    resolve(build, "server", supportModule),
  );
}

await cp(
  resolve(root, "shared/browser-build.mjs"),
  resolve(build, "shared/browser-build.mjs"),
);
