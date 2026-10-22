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
      readInstalledVersion: async () => "0.84.2",
      fetchLatest,
      checkExtensions,
      offline: () => false,
    });

    await expect(checker.check()).resolves.toEqual({
      currentVersion: "0.84.2",
      installedVersion: "0.84.2",
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

  it("rechecks the installed version and packages without restarting the Host", async () => {
    let installedVersion = "1.3.0";
    let latestVersion = "1.4.0";
    let packages = [
      { displayName: "pi-tools", type: "npm" as const, scope: "user" as const },
    ];
    const readInstalledVersion = vi.fn(async () => installedVersion);
    const checker = new PiUpdateChecker({
      currentVersion: "1.3.0",
      readInstalledVersion,
      fetchLatest: async () => latest(latestVersion),
      checkExtensions: async () => packages,
      offline: () => false,
    });
    const before = await checker.check();
    expect(before.pi.kind).toBe("available");

    installedVersion = "1.4.0";
    packages = [];
    expect(await checker.check()).toEqual(before);
    expect(readInstalledVersion).toHaveBeenCalledTimes(1);
    await expect(checker.check(true)).resolves.toEqual({
      currentVersion: "1.3.0",
      installedVersion: "1.4.0",
      pi: { kind: "current", latestVersion: "1.4.0" },
      extensions: { kind: "none" },
    });

    latestVersion = "1.5.0";
    await expect(checker.check(true)).resolves.toMatchObject({
      installedVersion: "1.4.0",
      pi: { kind: "available", latestVersion: "1.5.0" },
    });
  });

  it("keeps local installation observations independent of remote availability", async () => {
    let offline = false;
    const readInstalledVersion = vi.fn(async () => "1.4.0");
    readInstalledVersion.mockRejectedValueOnce(new Error("Pi was removed"));
    const fetchLatest = vi.fn(async () => latest("1.4.0"));
    const checker = new PiUpdateChecker({
      currentVersion: "1.3.0",
      readInstalledVersion,
      fetchLatest,
      checkExtensions: async () => [],
      offline: () => offline,
    });
    await expect(checker.check()).resolves.toMatchObject({
      installedVersion: null,
      pi: { kind: "unavailable" },
      extensions: { kind: "none" },
    });

    offline = true;
    await expect(checker.check(true)).resolves.toEqual({
      currentVersion: "1.3.0",
      installedVersion: "1.4.0",
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("reports the two checks independently", async () => {
    const checker = new PiUpdateChecker({
      currentVersion: "0.84.2",
      readInstalledVersion: async () => "0.84.2",
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
