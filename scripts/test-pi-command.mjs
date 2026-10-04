import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const piRoot = resolve(
  import.meta.dirname,
  "../node_modules/@earendil-works/pi-coding-agent",
);
const piManifest = JSON.parse(
  readFileSync(resolve(piRoot, "package.json"), "utf8"),
);
export const testPiCommand =
  process.env.INSPIRE_TEST_PI_COMMAND ?? resolve(piRoot, piManifest.bin.pi);
