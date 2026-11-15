import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { npmInvocation } from "../server/npm-command.mjs";
import {
  npmPackageRecord,
  packageSizeReport,
} from "./npm-package-manifest.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function execNpm(args, options = {}) {
  const invocation = npmInvocation(args, {
    environment: options.env ?? process.env,
    cwd: options.cwd ?? root,
  });
  return exec(invocation.command, invocation.args, {
    ...options,
    env: invocation.environment,
  });
}

const temporary = await mkdtemp(join(tmpdir(), "inspire-size-report-"));
try {
  // The release build is prepared by the package script before this program
  // runs. Ignore lifecycle scripts here so the measured tarball is exactly the
  // prepared artifact rather than a second, implicit rebuild.
  const { stdout } = await execNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, maxBuffer: 1_024 * 1_024 },
  );
  const record = npmPackageRecord(JSON.parse(stdout), "npm pack");
  if (typeof record.filename !== "string" || record.filename.length === 0) {
    throw new Error("npm pack did not report a package");
  }
  console.log(JSON.stringify(packageSizeReport(record), null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
