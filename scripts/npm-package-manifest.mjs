/** Parse npm's JSON output even when lifecycle output precedes its final JSON
 * record. npm has emitted both direct records and package-name-keyed records
 * across supported CLI versions. */
export function parseNpmJsonOutput(output, label = "npm") {
  const candidates = [0];
  for (const match of output.matchAll(/^[{[]/gmu)) {
    candidates.push(match.index ?? 0);
  }
  for (const index of candidates.sort((left, right) => right - left)) {
    try {
      const value = JSON.parse(output.slice(index));
      if (value && typeof value === "object") return value;
    } catch {
      // Try an earlier line: lifecycle output can precede the JSON object.
    }
  }
  throw new Error(`${label} did not return a trailing JSON manifest`);
}

/** Return the package record from npm's array, direct-object, or keyed-object
 * JSON shapes without accepting an unrelated nested object. */
export function npmPackageRecord(manifest, label = "npm") {
  if (Array.isArray(manifest)) {
    const [record] = manifest;
    if (record && typeof record === "object") return record;
  } else if (manifest && typeof manifest === "object") {
    if ("filename" in manifest || "id" in manifest) return manifest;
    const record = Object.values(manifest).find(
      (value) =>
        value &&
        typeof value === "object" &&
        ("filename" in value || "id" in value),
    );
    if (record) return record;
  }
  throw new Error(`${label} did not report a package record`);
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
