import { dirname, resolve } from "node:path";

// Shared by the test Host and browser assertions; never the installed checkout.
export const browserWorkspace = resolve(
  process.env.INSPIRE_BROWSER_TEST_OUTPUT_DIR ?? "output/playwright",
  "workspace",
);

export const browserFixtureHome = resolve(
  dirname(browserWorkspace),
  "fixture-home",
);

// A fixture project may remain the working directory of an idle Pi until the
// fixture Host exits. Keep these directories under that Host's lifetime.
export const browserFixtureProjects = resolve(
  dirname(browserWorkspace),
  "fixture-projects",
);
