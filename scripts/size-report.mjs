import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { npmPackageRecord } from "./npm-package-manifest.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredReleasePaths = [
  "build/server/index.js",
  "dist/index.html",
  "dist/THIRD_PARTY_NOTICES.txt",
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function category(path) {
  if (/\.(?:woff2?|ttf|otf)$/i.test(path)) return "fonts";
  if (/\.js$/i.test(path)) return "javascript";
  if (/\.css$/i.test(path)) return "css";
  return "other";
}

function coldStartFont(path) {
  return /(?:fluxmonosc-(?:regular|medium)-core|katex_(?:main|math|sansserif)-(?:regular|italic))/i.test(
    path,
  );
}

async function assertPreparedRelease() {
  const missing = [];
  for (const path of requiredReleasePaths) {
    try {
      if (!(await stat(join(root, path))).isFile()) missing.push(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Size report requires a prepared release build; missing ${missing.join(", ")}`,
    );
  }
}

function assertPackagedRelease(packageDirectory, files, breakdown) {
  const packagedPaths = new Set(
    files.map((file) => relative(packageDirectory, file).replaceAll("\\", "/")),
  );
  const missing = requiredReleasePaths.filter(
    (path) => !packagedPaths.has(path),
  );
  if (missing.length > 0) {
    throw new Error(
      `Size report tarball is missing release artifacts: ${missing.join(", ")}`,
    );
  }
  const emptyCategories = Object.entries(breakdown)
    .filter(([, bytes]) => bytes === 0)
    .map(([name]) => name);
  if (emptyCategories.length > 0) {
    throw new Error(
      `Size report tarball has no packaged ${emptyCategories.join(", ")}`,
    );
  }
}

await assertPreparedRelease();
const temporary = await mkdtemp(join(tmpdir(), "inspire-size-report-"));
try {
  // The release build is prepared by the package script before this program
  // runs. Ignore lifecycle scripts here so the measured tarball is exactly the
  // prepared artifact rather than a second, implicit rebuild.
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, maxBuffer: 1_024 * 1_024 },
  );
  const record = npmPackageRecord(JSON.parse(stdout), "npm pack");
  if (typeof record.filename !== "string" || record.filename.length === 0) {
    throw new Error("npm pack did not report a package");
  }
  const tarball = join(temporary, record.filename);
  await exec("tar", ["-xzf", tarball, "-C", temporary]);
  const packageDirectory = join(temporary, "package");
  const files = await filesUnder(packageDirectory);
  const breakdown = { javascript: 0, css: 0, fonts: 0, other: 0 };
  // This is a package-name heuristic, not a browser network measurement.
  // Runtime font transfer is reported separately by the browser evidence.
  const coldStartFontCandidates = {
    files: 0,
    bytes: 0,
    measurement: "static-package-candidates",
  };
  for (const file of files) {
    const size = (await stat(file)).size;
    breakdown[category(file)] += size;
    if (coldStartFont(relative(packageDirectory, file))) {
      coldStartFontCandidates.files += 1;
      coldStartFontCandidates.bytes += size;
    }
  }
  assertPackagedRelease(packageDirectory, files, breakdown);

  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        tarball: { file: basename(tarball), bytes: Number(record.size) },
        unpacked: {
          bytes: Number(record.unpackedSize),
          files: Number(record.totalFiles ?? record.entryCount),
        },
        packagedBytes: breakdown,
        coldStartFontCandidates,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
