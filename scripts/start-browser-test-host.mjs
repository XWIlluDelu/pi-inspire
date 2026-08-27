import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profile = process.argv[2] ?? "chromium";
const port = Number(process.argv[3] ?? "4592");
if (!/^[a-z0-9-]+$/u.test(profile) || !Number.isInteger(port) || port < 1) {
  throw new Error("Usage: start-browser-test-host.mjs <profile> <port>");
}
const output = join(root, "output", "playwright", "hosts", profile);
const preferences = join(output, "preferences.json");
const state = join(output, "instance.json");
const diagnostics = join(output, "diagnostics.jsonl");
await mkdir(output, { recursive: true });
await Promise.all([
  rm(preferences, { force: true }),
  rm(state, { force: true }),
  rm(`${state}.launcher-lock`, { force: true }),
  rm(`${state}.stop-request`, { force: true }),
  rm(diagnostics, { force: true }),
]);

const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piManifest = JSON.parse(
  await readFile(join(piRoot, "package.json"), "utf8"),
);
if (typeof piManifest.bin?.pi !== "string")
  throw new Error("The browser test Pi package has no CLI entry");

const child = spawn(
  process.execPath,
  [
    join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    join(root, "server", "index.ts"),
  ],
  {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      INSPIRE_INSTALLATION_ROOT: root,
      INSPIRE_TOKEN: "inspire-browser-test-token",
      INSPIRE_PI_COMMAND: join(piRoot, piManifest.bin.pi),
      INSPIRE_MOCK: "1",
      INSPIRE_MOCK_WORKSPACE: root,
      INSPIRE_MOCK_STREAM_INTERVAL_MS: "250",
      INSPIRE_PREFERENCES_PATH: preferences,
      INSPIRE_STATE_PATH: state,
      INSPIRE_LOG_PATH: diagnostics,
      INSPIRE_OPEN: "0",
      INSPIRE_PORT: String(port),
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
