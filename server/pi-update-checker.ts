import {
  type PiExtensionUpdate,
  type PiExtensionUpdateStatus,
  type PiUpdateCheckResponse,
  type PiVersionUpdateStatus,
} from "../shared/contracts.js";
import {
  isNewerStableRelease,
  normalizedVersion,
  parseSemanticVersion,
} from "./semantic-version.js";

const LATEST_PI_VERSION_URL = "https://pi.dev/api/latest-version";
const PI_CHANGELOG_URL = "https://pi.dev/changelog";
const UPDATE_REQUEST_TIMEOUT_MS = 10_000;

type FetchLatest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PackageUpdateCandidate {
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

interface PiUpdateCheckerOptions {
  currentVersion: string;
  readInstalledVersion: () => Promise<string>;
  checkExtensions: () => Promise<PackageUpdateCandidate[]>;
  fetchLatest?: FetchLatest;
  offline?: () => boolean;
}

/** Mirrors Pi's read-only startup checks. */
export async function probePiUpdate(
  options: PiUpdateCheckerOptions,
): Promise<PiUpdateCheckResponse> {
  const installedVersion = await options
    .readInstalledVersion()
    .then((version) => (parseSemanticVersion(version, false) ? version : null))
    .catch(() => null);
  const [pi, extensions] =
    (options.offline?.() ?? Boolean(process.env.PI_OFFLINE))
      ? ([{ kind: "unavailable" }, { kind: "unavailable" }] as const)
      : await Promise.all([
          checkPiVersion(options, installedVersion),
          checkExtensionPackages(options.checkExtensions),
        ]);
  return {
    currentVersion: options.currentVersion,
    installedVersion,
    pi,
    extensions,
  };
}

async function checkPiVersion(
  { currentVersion, fetchLatest = fetch }: PiUpdateCheckerOptions,
  installedVersion: string | null,
): Promise<PiVersionUpdateStatus> {
  if (!installedVersion) return { kind: "unavailable" };
  try {
    const response = await fetchLatest(LATEST_PI_VERSION_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": `pi/${currentVersion} (${process.platform}; node/${process.version}; ${process.arch})`,
      },
      signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "unavailable" };
    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== "string") return { kind: "unavailable" };
    const latest = parseSemanticVersion(payload.version, true);
    const current = parseSemanticVersion(installedVersion, false);
    if (!latest || !current) return { kind: "unavailable" };
    const latestVersion = normalizedVersion(latest);
    return isNewerStableRelease(latest, current)
      ? {
          kind: "available",
          latestVersion,
          releaseUrl: PI_CHANGELOG_URL,
        }
      : { kind: "current", latestVersion };
  } catch {
    return { kind: "unavailable" };
  }
}

async function checkExtensionPackages(
  checkExtensions: PiUpdateCheckerOptions["checkExtensions"],
): Promise<PiExtensionUpdateStatus> {
  try {
    const updates: PiExtensionUpdate[] = (await checkExtensions())
      .map(({ displayName, type }) => ({ displayName, type }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return updates.length > 0
      ? { kind: "available", updates }
      : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}
