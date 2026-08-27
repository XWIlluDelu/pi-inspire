import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/tsx/dist/cli.mjs"),
    "watch",
    resolve(root, "server/index.ts"),
  ],
  {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      INSPIRE_TOKEN: process.env.INSPIRE_TOKEN ?? "inspire-dev-token",
    },
  },
);
const forward = (signal) => {
  if (child.exitCode === null) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
