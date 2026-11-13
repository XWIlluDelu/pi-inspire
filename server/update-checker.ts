import { type UpdateCheckResponse } from "../shared/contracts.js";
import {
  isNewerStableRelease,
  normalizedVersion,
  parseSemanticVersion,
} from "./semantic-version.js";

const GITHUB_API_VERSION = "2026-03-10";
const UPDATE_REQUEST_TIMEOUT_MS = 5_000;

type FetchLatest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface GitHubRepository {
  owner: string;
  name: string;
}

interface UpdateCheckerOptions {
  currentVersion: string;
  repositoryUrl: string | undefined;
  fetchLatest?: FetchLatest;
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

export async function probeInspireUpdate({
  currentVersion,
  repositoryUrl,
  fetchLatest = fetch,
}: UpdateCheckerOptions): Promise<UpdateCheckResponse> {
  const repository = githubRepository(repositoryUrl);
  const current = parseSemanticVersion(currentVersion, false);
  if (!repository || !current) return { kind: "unavailable" };
  try {
    const { owner, name } = repository;
    const response = await fetchLatest(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `inspire-pi-gui/${currentVersion}`,
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
    if (!isNewerStableRelease(latest, current)) return { kind: "current" };

    const latestVersion = normalizedVersion(latest);
    return {
      kind: "available",
      update: {
        currentVersion: currentVersion,
        latestVersion,
        releaseUrl: `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(payload.tag_name)}`,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}
