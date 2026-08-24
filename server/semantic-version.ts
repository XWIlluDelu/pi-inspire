interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

function numericPart(value: string): number | null {
  const part = Number(value);
  return Number.isSafeInteger(part) ? part : null;
}

export function parseSemanticVersion(
  value: string,
  stableOnly: boolean,
): SemanticVersion | null {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    );
  if (!match || (stableOnly && match[4])) return null;
  const major = numericPart(match[1]!);
  const minor = numericPart(match[2]!);
  const patch = numericPart(match[3]!);
  if (major === null || minor === null || patch === null) return null;
  return { major, minor, patch, prerelease: Boolean(match[4]) };
}

export function normalizedVersion(version: SemanticVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function isNewerStableRelease(
  latest: SemanticVersion,
  current: SemanticVersion,
): boolean {
  for (const key of ["major", "minor", "patch"] as const) {
    if (latest[key] !== current[key]) return latest[key] > current[key];
  }
  return current.prerelease;
}
