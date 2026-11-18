import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Shared by the test Host and browser assertions; never the installed checkout.
export const browserWorkspace = resolve(
  process.env.INSPIRE_BROWSER_TEST_OUTPUT_DIR ?? "output/playwright",
  "workspace",
);

export const browserFixtureHome = resolve(
  dirname(browserWorkspace),
  "fixture-home",
);

export async function createBrowserProject(prefix) {
  const projects =
    process.env.INSPIRE_BROWSER_TEST_PROJECTS ?? join(browserFixtureHome, "projects");
  await mkdir(projects, { recursive: true });
  return mkdtemp(join(projects, prefix));
}
