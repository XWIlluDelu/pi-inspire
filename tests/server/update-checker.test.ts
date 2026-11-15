import { describe, expect, it, vi } from "vitest";
import { probePiUpdate } from "../../server/pi-update-checker.js";
import { probeInspireUpdate } from "../../server/update-checker.js";
import { UpdateCoordinator } from "../../server/update-coordinator.js";

const repositoryUrl = "git+https://github.com/example/inspire.git";
const release = (tag_name: string) => Response.json({ tag_name });

describe("Inspire release observations", () => {
  it("shares one stable-release check across callers and refreshes the cached result when requested or expired", async () => {
    let now = 10_000;
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetchLatest = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending)
      .mockImplementation(async () => release("v2.0.0"));
    const coordinator = new UpdateCoordinator({
      currentPiVersion: "1.0.0",
      probeInspire: () =>
        probeInspireUpdate({
          currentVersion: "2.0.0-rc.1",
          repositoryUrl,
          fetchLatest,
        }),
      now: () => now,
    });
    const check = (force = false) =>
      coordinator
        .checkInspire(force)
        .then((status) => status.inspireUpdateCheck);
    const first = check();
    const second = check();
    await vi.waitFor(() => expect(fetchLatest).toHaveBeenCalledOnce());
    expect(fetchLatest).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/example/inspire/releases/latest",
      expect.anything(),
    );
    expect(
      new Headers(fetchLatest.mock.calls[0]?.[1]?.headers).has("Authorization"),
    ).toBe(false);
    answer(release("v2.0.0"));
    const result = {
      kind: "available",
      update: {
        currentVersion: "2.0.0-rc.1",
        latestVersion: "2.0.0",
        releaseUrl: "https://github.com/example/inspire/releases/tag/v2.0.0",
      },
    };
    await expect(Promise.all([first, second])).resolves.toEqual([
      result,
      result,
    ]);

    await expect(check(true)).resolves.toEqual(result);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    now += 6 * 60 * 60_000 - 1;
    await expect(check()).resolves.toEqual(result);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    now++;
    await expect(check()).resolves.toEqual(result);
    expect(fetchLatest).toHaveBeenCalledTimes(3);
  });

  it("distinguishes current, unpublished and unavailable releases", async () => {
    const fetchLatest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(release("v1.3.2"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(release("nightly"))
      .mockRejectedValueOnce(new Error("offline"));
    const check = () =>
      probeInspireUpdate({
        currentVersion: "1.3.2",
        repositoryUrl,
        fetchLatest,
      });

    await expect(check()).resolves.toEqual({ kind: "current" });
    await expect(check()).resolves.toEqual({ kind: "unreleased" });
    await expect(check()).resolves.toEqual({ kind: "unavailable" });
    await expect(check()).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("Pi and extension observations", () => {
  it("refreshes installed Pi and package observations independently of the Host-loaded version", async () => {
    const readInstalledVersion = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("1.3.0")
      .mockResolvedValue("1.4.0");
    const checkExtensions = vi
      .fn<
        () => Promise<{ displayName: string; type: "npm"; scope: "user" }[]>
      >()
      .mockResolvedValueOnce([
        { displayName: "z-addon", type: "npm", scope: "user" },
        { displayName: "a-addon", type: "npm", scope: "user" },
      ])
      .mockResolvedValue([]);
    const check = () =>
      probePiUpdate({
        currentVersion: "1.3.0",
        readInstalledVersion,
        fetchLatest: async () => Response.json({ version: "1.4.0" }),
        checkExtensions,
        offline: () => false,
      });

    const before = await check();
    expect(before).toEqual({
      currentVersion: "1.3.0",
      installedVersion: "1.3.0",
      pi: {
        kind: "available",
        latestVersion: "1.4.0",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: {
        kind: "available",
        updates: [
          { displayName: "a-addon", type: "npm" },
          { displayName: "z-addon", type: "npm" },
        ],
      },
    });
    expect(readInstalledVersion).toHaveBeenCalledOnce();
    await expect(check()).resolves.toEqual({
      currentVersion: "1.3.0",
      installedVersion: "1.4.0",
      pi: { kind: "current", latestVersion: "1.4.0" },
      extensions: { kind: "none" },
    });
  });

  it("retains local Pi identity and independent extension results when remote checks fail or are disabled", async () => {
    let offline = false;
    const readInstalledVersion = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Pi was removed"))
      .mockResolvedValue("1.4.0");
    const fetchLatest = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const checkExtensions = vi.fn(async () => [
      {
        displayName: "extension",
        type: "git" as const,
        scope: "user" as const,
      },
    ]);
    const check = () =>
      probePiUpdate({
        currentVersion: "1.3.0",
        readInstalledVersion,
        fetchLatest,
        checkExtensions,
        offline: () => offline,
      });
    const extensions = {
      kind: "available",
      updates: [{ displayName: "extension", type: "git" }],
    };
    await expect(check()).resolves.toMatchObject({
      installedVersion: null,
      pi: { kind: "unavailable" },
      extensions,
    });
    expect(fetchLatest).not.toHaveBeenCalled();

    await expect(check()).resolves.toMatchObject({
      installedVersion: "1.4.0",
      pi: { kind: "unavailable" },
      extensions,
    });

    offline = true;
    fetchLatest.mockClear();
    checkExtensions.mockClear();
    await expect(check()).resolves.toMatchObject({
      installedVersion: "1.4.0",
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(checkExtensions).not.toHaveBeenCalled();
  });
});
