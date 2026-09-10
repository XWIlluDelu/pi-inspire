import { resolve } from "node:path";

// Shared by the test Host and browser assertions; never the installed checkout.
export const browserWorkspace = resolve("output", "playwright", "workspace");
