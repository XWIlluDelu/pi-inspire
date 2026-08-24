import {
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckResponse,
} from "../shared/contracts.js";
import {
  isNewerStableRelease,
  normalizedVersion,
  parseSemanticVersion,
} from "./semantic-version.js";

const GITHUB_API_VERSION = "2026-03-10";
const UPDATE_REQUEST_TIMEOUT_MS = 5_000;
const FAILED_CHECK_CACHE_MS = 60 * 60 * 1_000;

type FetchLatest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface GitHubRepository {
  owner: string;
  name: string;
}

export interface UpdateCheckerLike {
  check(force?: boolean): Promise<UpdateCheckResponse>;
}

interface UpdateCheckerOptions {
  currentVersion: string;
  repositoryUrl: string | undefined;
  fetchLatest?: FetchLatest;
  now?: () => number;
}

function githubRepository(
  repositoryUrl: string | undefined,
): GitHubRepository | null {
  if (!repositoryUrl) return null;
  try {
    const parsed = new URL(repositoryUrl.replace(/^git\+/, ""));
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com")
      return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    const owner = parts[0]!;
    const name = parts[1]!.replace(/\.git$/, "");
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name))
      return null;
    return { owner, name };
  } catch {
    return null;
  }
}

/**
 * Reads GitHub's public Latest Release record without putting remote network
 * access in the browser. Results and failures are bounded and shared by every
 * authenticated client of this host process.
 */
export class GitHubReleaseUpdateChecker implements UpdateCheckerLike {
  private readonly repository: GitHubRepository | null;
  private readonly current: ReturnType<typeof parseSemanticVersion>;
  private readonly fetchLatest: FetchLatest;
  private readonly now: () => number;
  private cached: { expiresAt: number; response: UpdateCheckResponse } | null =
    null;
  private inFlight: Promise<UpdateCheckResponse> | null = null;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.repository = githubRepository(options.repositoryUrl);
    this.current = parseSemanticVersion(options.currentVersion, false);
    this.fetchLatest = options.fetchLatest ?? fetch;
    this.now = options.now ?? Date.now;
  }

  check(force = false): Promise<UpdateCheckResponse> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.cached && this.cached.expiresAt > this.now())
      return Promise.resolve(this.cached.response);

    this.inFlight = this.checkLatest()
      .catch((): UpdateCheckResponse => ({ kind: "unavailable" }))
      .then((response) => {
        this.cached = {
          response,
          expiresAt:
            this.now() +
            (response.kind === "unavailable"
              ? FAILED_CHECK_CACHE_MS
              : UPDATE_CHECK_INTERVAL_MS),
        };
        return response;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async checkLatest(): Promise<UpdateCheckResponse> {
    if (!this.repository || !this.current) return { kind: "unavailable" };
    const { owner, name } = this.repository;
    const response = await this.fetchLatest(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `inspire-pi-gui/${this.options.currentVersion}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return { kind: "unreleased" };
    if (!response.ok) return { kind: "unavailable" };
    const payload = (await response.json()) as { tag_name?: unknown };
    if (typeof payload.tag_name !== "string") return { kind: "unavailable" };
    const latest = parseSemanticVersion(payload.tag_name, true);
    if (!latest) return { kind: "unavailable" };
    if (!isNewerStableRelease(latest, this.current)) return { kind: "current" };

    const latestVersion = normalizedVersion(latest);
    return {
      kind: "available",
      update: {
        currentVersion: this.options.currentVersion,
        latestVersion,
        releaseUrl: `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(payload.tag_name)}`,
      },
    };
  }
}
