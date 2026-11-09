import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { executablePathDirectories } from "../../../server/platform-environment.mjs";
import { prepareWorkbenchEnvironment } from "../../fixtures/workbench-environment.js";

const root = resolve(process.env.INSPIRE_BROWSER_FIXTURE_ROOT!);
const cwd = resolve(process.env.INSPIRE_BROWSER_FIXTURE_WORKSPACE!);
const image = (
  await readFile(
    join(cwd, "tests/browser/fixtures/file-previews/training curve.png"),
  )
).toString("base64");
const { env } = await prepareWorkbenchEnvironment(root, {
  cwd,
  image,
  streamIntervalMs: 250,
});
const hostKeys = new Set([
  "INSPIRE_INSTALLATION_ROOT",
  "INSPIRE_TOKEN",
  "INSPIRE_PI_COMMAND",
  "INSPIRE_PREFERENCES_PATH",
  "INSPIRE_STATE_PATH",
  "INSPIRE_STOP_REQUEST_PATH",
  "INSPIRE_LOG_PATH",
  "INSPIRE_PORT",
  "INSPIRE_HOST",
  "INSPIRE_OPEN",
  "INSPIRE_TERMINAL_IN_PROCESS",
]);
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => hostKeys.has(key)),
);
// The isolated Windows PATH omits Git for Windows. Keep just its executable
// directory for both repository setup and the Host's Changes requests.
const gitDirectory =
  process.platform === "win32"
    ? executablePathDirectories(process.env.PATH ?? "").find((directory) =>
        existsSync(join(directory, "git.exe")),
      )
    : undefined;
// Only the separate Host process adopts this environment.
for (const [key, value] of Object.entries(env)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
Object.assign(process.env, hostEnvironment);
if (gitDirectory) process.env.PATH += `${delimiter}${gitDirectory}`;
// Changes acceptance inspects an actual disposable Git index and working tree.
const git = (args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "missing-gitconfig"),
    },
  });
git(["init", "-b", "fixture/analysis"]);
git(["config", "user.name", "Fixture"]);
git(["config", "user.email", "fixture@example.invalid"]);
const page = join(cwd, "tests/browser/fixtures/file-previews/page.html");
const source = await readFile(page, "utf8");
await writeFile(
  page,
  source.replace(
    "Quiet systems, legible signals.",
    "Quiet systems, readable signals.",
  ),
);
git(["add", "."]);
git(["commit", "-m", "Seed preview files"]);
await writeFile(page, source);
await import("../../../server/index.js");
