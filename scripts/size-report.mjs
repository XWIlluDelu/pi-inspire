import { resolve } from "node:path";
import {
  execNpm,
  npmPackageRecord,
  packageSizeReport,
} from "./npm-package-manifest.mjs";

// The package script already built the release. Measure that artifact without
// executing prepack again or writing a tarball.
const { stdout } = await execNpm(
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  {
    cwd: resolve(import.meta.dirname, ".."),
  },
);
console.log(
  JSON.stringify(
    packageSizeReport(npmPackageRecord(stdout, "npm pack")),
    null,
    2,
  ),
);
