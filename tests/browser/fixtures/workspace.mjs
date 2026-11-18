import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

// Shared by the test Host and browser assertions; never the installed checkout.
export const browserFixtureOutput = resolve(
  process.env.INSPIRE_BROWSER_TEST_OUTPUT_DIR ?? "output/playwright",
);
export const browserWorkspace = join(browserFixtureOutput, "workspace");
export const browserFixtureHome = join(browserFixtureOutput, "fixture-home");

export async function createBrowserProject(prefix) {
  const projects = join(browserFixtureHome, "projects");
  await mkdir(projects, { recursive: true });
  return mkdtemp(join(projects, prefix));
}
