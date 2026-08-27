import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const [portText] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Usage: node scripts/start-browser-test-host.mjs <port>");
  process.exit(64);
}

const output = resolve("output", "playwright");
const preferencesPath = resolve(output, "preferences.json");
await mkdir(output, { recursive: true });
await rm(preferencesPath, { force: true });

const piCommand = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.cmd" : "pi",
);
const child = spawn(
  process.execPath,
  [resolve("node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"],
  {
    env: {
      ...process.env,
      INSPIRE_INSTALLATION_ROOT: resolve("."),
      INSPIRE_TOKEN: "inspire-browser-test-token",
      INSPIRE_PI_COMMAND: piCommand,
      INSPIRE_MOCK: "1",
      INSPIRE_MOCK_WORKSPACE: resolve("."),
      INSPIRE_MOCK_STREAM_INTERVAL_MS: "250",
      INSPIRE_PREFERENCES_PATH: preferencesPath,
      INSPIRE_PORT: String(port),
    },
    stdio: "inherit",
    windowsHide: true,
  },
);

const relay = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // Child exit owns settlement.
  }
};
const onInterrupt = () => relay("SIGINT");
const onTerminate = () => relay("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);

try {
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (exitCode) => resolveExit(exitCode));
  });
  process.exitCode = code ?? 1;
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
