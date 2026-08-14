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
