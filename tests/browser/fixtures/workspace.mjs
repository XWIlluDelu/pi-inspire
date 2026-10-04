import { resolve } from "node:path";

// Shared by the test Host and browser assertions; never the installed checkout.
export const browserWorkspace = resolve(
  process.env.INSPIRE_BROWSER_TEST_OUTPUT_DIR ?? "output/playwright",
  "workspace",
);
