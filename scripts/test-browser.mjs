import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projects = await mkdtemp(join(tmpdir(), "inspire-browser-projects-"));
const playwright = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@playwright/test/package.json")),
);
try {
  const child = spawn(
    process.execPath,
    [playwright, "test", ...process.argv.slice(2)],
    {
      env: { ...process.env, INSPIRE_BROWSER_TEST_PROJECTS: projects },
      stdio: "inherit",
    },
  );
  const [code] = await once(child, "close");
  process.exitCode = code ?? 1;
} finally {
  // Native Pi processes can keep projects open until Playwright stops the Host.
  await rm(projects, { recursive: true, force: true, maxRetries: 3 });
}
