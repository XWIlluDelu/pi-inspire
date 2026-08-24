import {
  UPDATE_CHECK_INTERVAL_MS,
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
const FAILED_CHECK_CACHE_MS = 60 * 60 * 1_000;

type FetchLatest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PackageUpdateCandidate {
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

export interface PiUpdateCheckerLike {
  check(force?: boolean): Promise<PiUpdateCheckResponse>;
}

interface PiUpdateCheckerOptions {
  currentVersion: string;
  checkExtensions: () => Promise<PackageUpdateCandidate[]>;
  fetchLatest?: FetchLatest;
  now?: () => number;
  offline?: () => boolean;
}

/** Mirrors Pi's read-only startup checks without exposing package mutation. */
export class PiUpdateChecker implements PiUpdateCheckerLike {
  private readonly fetchLatest: FetchLatest;
  private readonly now: () => number;
  private readonly offline: () => boolean;
  private cached: {
    expiresAt: number;
    response: PiUpdateCheckResponse;
  } | null = null;
  private inFlight: Promise<PiUpdateCheckResponse> | null = null;

  constructor(private readonly options: PiUpdateCheckerOptions) {
    this.fetchLatest = options.fetchLatest ?? fetch;
    this.now = options.now ?? Date.now;
    this.offline = options.offline ?? (() => Boolean(process.env.PI_OFFLINE));
  }

  check(force = false): Promise<PiUpdateCheckResponse> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.cached && this.cached.expiresAt > this.now())
      return Promise.resolve(this.cached.response);

    this.inFlight = this.checkLatest()
      .then((response) => {
        const unavailable =
          response.pi.kind === "unavailable" ||
          response.extensions.kind === "unavailable";
        this.cached = {
          response,
          expiresAt:
            this.now() +
            (unavailable ? FAILED_CHECK_CACHE_MS : UPDATE_CHECK_INTERVAL_MS),
        };
        return response;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async checkLatest(): Promise<PiUpdateCheckResponse> {
    if (this.offline()) return this.unavailable();
    const [pi, extensions] = await Promise.all([
      this.checkPiVersion(),
      this.checkExtensionPackages(),
    ]);
    return { currentVersion: this.options.currentVersion, pi, extensions };
  }

  private unavailable(): PiUpdateCheckResponse {
    return {
      currentVersion: this.options.currentVersion,
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    };
  }

  private async checkPiVersion(): Promise<PiVersionUpdateStatus> {
    try {
      const response = await this.fetchLatest(LATEST_PI_VERSION_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": `pi/${this.options.currentVersion} (${process.platform}; node/${process.version}; ${process.arch})`,
        },
        signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return { kind: "unavailable" };
      const payload = (await response.json()) as { version?: unknown };
      if (typeof payload.version !== "string") return { kind: "unavailable" };
      const latest = parseSemanticVersion(payload.version, true);
      const current = parseSemanticVersion(this.options.currentVersion, false);
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

  private async checkExtensionPackages(): Promise<PiExtensionUpdateStatus> {
    try {
      const updates: PiExtensionUpdate[] = (
        await this.options.checkExtensions()
      )
        .map(({ displayName, type }) => ({ displayName, type }))
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        );
      return updates.length > 0
        ? { kind: "available", updates }
        : { kind: "none" };
    } catch {
      return { kind: "unavailable" };
    }
  }
}
