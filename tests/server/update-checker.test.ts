import { describe, expect, it, vi } from "vitest";
import { GitHubReleaseUpdateChecker } from "../../server/update-checker.js";
import { UPDATE_CHECK_INTERVAL_MS } from "../../shared/contracts.js";

function release(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub release update checker", () => {
  it("reports a newer stable release from the package repository", async () => {
    const fetchLatest = vi.fn(async () => release("v1.4.0"));
    const checker = new GitHubReleaseUpdateChecker({
      currentVersion: "1.3.2",
      repositoryUrl: "git+https://github.com/example/inspire.git",
      fetchLatest,
    });

    await expect(checker.check()).resolves.toEqual({
      kind: "available",
      update: {
        currentVersion: "1.3.2",
        latestVersion: "1.4.0",
        releaseUrl: "https://github.com/example/inspire/releases/tag/v1.4.0",
      },
    });
    expect(fetchLatest).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/inspire/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats the stable form of a running prerelease as an update", async () => {
    const checker = new GitHubReleaseUpdateChecker({
      currentVersion: "2.0.0-rc.1",
      repositoryUrl: "https://github.com/example/inspire",
      fetchLatest: vi.fn(async () => release("v2.0.0")),
    });

    await expect(checker.check()).resolves.toMatchObject({
      kind: "available",
      update: { latestVersion: "2.0.0" },
    });
  });

  it("coalesces concurrent checks and caches current releases for six hours", async () => {
    let now = 10_000;
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetchLatest = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(() => pending)
      .mockImplementation(async () => release("v1.3.2"));
    const checker = new GitHubReleaseUpdateChecker({
      currentVersion: "1.3.2",
      repositoryUrl: "https://github.com/example/inspire",
      fetchLatest,
      now: () => now,
    });

    const first = checker.check();
    const second = checker.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    answer(release("v1.3.2"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "current" },
      { kind: "current" },
    ]);

    await checker.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    now += UPDATE_CHECK_INTERVAL_MS + 1;
    await checker.check();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed metadata and remote failures non-blocking", async () => {
    const fetchLatest = vi.fn(async () => release("nightly"));
    const malformed = new GitHubReleaseUpdateChecker({
      currentVersion: "1.3.2",
      repositoryUrl: "https://github.com/example/inspire",
      fetchLatest,
    });
    await expect(malformed.check()).resolves.toEqual({ kind: "unavailable" });

    const unreachable = new GitHubReleaseUpdateChecker({
      currentVersion: "1.3.2",
      repositoryUrl: "https://github.com/example/inspire",
      fetchLatest: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(unreachable.check()).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
