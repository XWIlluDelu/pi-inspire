import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { npmInvocation } from "../server/npm-command.mjs";

const exec = promisify(execFile);

export function execNpm(args, { cwd, env = process.env, ...options }) {
  const invocation = npmInvocation(args, { cwd, environment: env });
  return exec(invocation.command, invocation.args, {
    cwd,
    env: invocation.environment,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

/** pack and publish each report one package, directly or in an array or keyed object. */
export function npmPackageRecord(stdout, label) {
  const manifest = JSON.parse(stdout);
  const record = manifest?.id ? manifest : Object.values(manifest ?? {})[0];
  if (!record?.id) throw new Error(`${label} did not report a package record`);
  return record;
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

export function packageSizeReport(record) {
  const files = record.files ?? [];
  const breakdown = { javascript: 0, css: 0, fonts: 0, other: 0 };
  // This is a package-name heuristic, not a browser network measurement.
  // Runtime font transfer is reported separately by the browser evidence.
  const coldStartFontCandidates = {
    files: 0,
    bytes: 0,
    measurement: "static-package-candidates",
  };
  for (const file of files) {
    const size = Number(file.size) || 0;
    breakdown[category(file.path ?? "")] += size;
    if (coldStartFont(file.path ?? "")) {
      coldStartFontCandidates.files += 1;
      coldStartFontCandidates.bytes += size;
    }
  }

  const packagedPaths = new Set(files.map((file) => file.path));
  const missing = [
    "build/server/index.js",
    "dist/index.html",
    "dist/THIRD_PARTY_NOTICES.txt",
  ].filter((path) => !packagedPaths.has(path));
  if (missing.length)
    throw new Error(
      `Size report tarball is missing release artifacts: ${missing.join(", ")}`,
    );
  const emptyCategories = Object.keys(breakdown).filter(
    (name) => breakdown[name] === 0,
  );
  if (emptyCategories.length)
    throw new Error(
      `Size report tarball has no packaged ${emptyCategories.join(", ")}`,
    );
  return {
    schemaVersion: 1,
    tarball: { file: record.filename, bytes: Number(record.size) },
    unpacked: {
      bytes: Number(record.unpackedSize),
      files: Number(record.totalFiles ?? record.entryCount),
    },
    packagedBytes: breakdown,
    coldStartFontCandidates,
  };
}
