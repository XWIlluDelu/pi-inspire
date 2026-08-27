import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const piRoot = resolve(
  import.meta.dirname,
  "node_modules/@earendil-works/pi-coding-agent",
);
const piManifest = JSON.parse(
  readFileSync(resolve(piRoot, "package.json"), "utf8"),
) as { bin?: { pi?: unknown } };
if (typeof piManifest.bin?.pi !== "string")
  throw new Error("The test Pi package has no CLI entry");

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "development",
      INSPIRE_PI_COMMAND: resolve(piRoot, piManifest.bin.pi),
    },
    include: ["tests/**/*.test.{ts,tsx,mjs}"],
    exclude: ["tests/portable/**"],
    environment: "node",
    setupFiles: ["tests/web/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
