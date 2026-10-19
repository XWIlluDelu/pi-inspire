import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(
  process.execPath,
  ["--watch", "--import", "tsx", resolve(root, "server/index.ts")],
  {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      // The coordinated dev entry supplies a private per-run credential.
      // Only the owned Vite listener opens its origin-bound pairing link.
      INSPIRE_OPEN: "0",
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
