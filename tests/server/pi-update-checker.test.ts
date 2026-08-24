import { describe, expect, it, vi } from "vitest";
import { PiUpdateChecker } from "../../server/pi-update-checker.js";

function latest(version: string): Response {
  return new Response(JSON.stringify({ ok: true, version }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("Pi update checker", () => {
  it("checks Pi and configured packages through their read-only sources", async () => {
    const fetchLatest = vi.fn(async () => latest("0.84.3"));
    const checkExtensions = vi.fn(async () => [
      {
        displayName: "pi-web-access",
        type: "npm" as const,
        scope: "user" as const,
      },
      {
        displayName: "@cortexkit/pi-magic-context",
        type: "npm" as const,
        scope: "user" as const,
      },
    ]);
    const checker = new PiUpdateChecker({
      currentVersion: "0.84.2",
      fetchLatest,
      checkExtensions,
      offline: () => false,
    });

    await expect(checker.check()).resolves.toEqual({
      currentVersion: "0.84.2",
      pi: {
        kind: "available",
        latestVersion: "0.84.3",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: {
        kind: "available",
        updates: [
          {
            displayName: "@cortexkit/pi-magic-context",
            type: "npm",
          },
          {
            displayName: "pi-web-access",
            type: "npm",
          },
        ],
      },
    });
    await checker.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await checker.check(true);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(checkExtensions).toHaveBeenCalledTimes(2);
  });

  it("reports the two checks independently", async () => {
    const checker = new PiUpdateChecker({
      currentVersion: "0.84.2",
      fetchLatest: vi.fn(async () => {
        throw new Error("offline");
      }),
      checkExtensions: vi.fn(async () => [
        {
          displayName: "pi-goal",
          type: "git" as const,
          scope: "project" as const,
        },
      ]),
      offline: () => false,
    });

    await expect(checker.check()).resolves.toMatchObject({
      pi: { kind: "unavailable" },
      extensions: {
        kind: "available",
        updates: [{ displayName: "pi-goal" }],
      },
    });
  });
});
