import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_SNOOZE_MS } from "../../shared/contracts.js";
import { UpdateCoordinator } from "../../server/update-coordinator.js";

const temporaryPaths: string[] = [];

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inspire-updates-"));
  temporaryPaths.push(directory);
  return join(directory, "state.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Host update coordinator", () => {
  it("runs one post-08:00 automatic check per persisted Host day", async () => {
    let now = new Date(2026, 7, 21, 7, 59).getTime();
    const path = await statePath();
    const inspireCheck = vi.fn(async () => ({ kind: "current" as const }));
    const piCheck = vi.fn(async () => ({
      currentVersion: "0.84.2",
      pi: { kind: "current" as const, latestVersion: "0.84.2" },
      extensions: { kind: "none" as const },
    }));
    const first = new UpdateCoordinator({
      currentPiVersion: "0.84.2",
      inspireChecker: { check: inspireCheck },
      piChecker: { check: piCheck },
      statePath: path,
      now: () => now,
    });

    await first.promptAccepted();
    expect(inspireCheck).not.toHaveBeenCalled();
    expect(piCheck).not.toHaveBeenCalled();

    now = new Date(2026, 7, 21, 8, 0).getTime();
    await Promise.all([first.promptAccepted(), first.promptAccepted()]);
    expect(inspireCheck).toHaveBeenCalledTimes(1);
    expect(piCheck).toHaveBeenCalledTimes(1);
    await first.close();

    const reloadedInspireCheck = vi.fn(async () => ({
      kind: "current" as const,
    }));
    const reloadedPiCheck = vi.fn(async () => ({
      currentVersion: "0.84.2",
      pi: { kind: "current" as const, latestVersion: "0.84.2" },
      extensions: { kind: "none" as const },
    }));
    const reloaded = new UpdateCoordinator({
      currentPiVersion: "0.84.2",
      inspireChecker: { check: reloadedInspireCheck },
      piChecker: { check: reloadedPiCheck },
      statePath: path,
      now: () => now,
    });

    await reloaded.promptAccepted();
    expect(reloadedInspireCheck).not.toHaveBeenCalled();
    expect(reloadedPiCheck).not.toHaveBeenCalled();

    now = new Date(2026, 7, 22, 8, 0).getTime();
    await reloaded.promptAccepted();
    expect(reloadedInspireCheck).toHaveBeenCalledTimes(1);
    expect(reloadedPiCheck).toHaveBeenCalledTimes(1);
    await reloaded.close();
  });

  it("persists one exact-set snooze and reveals a changed update set", async () => {
    const now = new Date(2026, 7, 21, 9, 0).getTime();
    const path = await statePath();
    let latestInspireVersion = "1.1.0";
    const options = () => ({
      currentPiVersion: "0.84.2",
      inspireChecker: {
        check: async () => ({
          kind: "available" as const,
          update: {
            currentVersion: "1.0.0",
            latestVersion: latestInspireVersion,
            releaseUrl: `https://github.com/example/inspire/releases/v${latestInspireVersion}`,
          },
        }),
      },
      piChecker: {
        check: async () => ({
          currentVersion: "0.84.2",
          pi: {
            kind: "available" as const,
            latestVersion: "0.84.3",
            releaseUrl: "https://pi.dev/changelog",
          },
          extensions: { kind: "none" as const },
        }),
      },
      statePath: path,
      now: () => now,
    });
    const first = new UpdateCoordinator(options());
    await Promise.all([first.checkInspire(), first.checkPi()]);
    const observed = await first.status();
    expect(observed.availableUpdateIdentity).not.toBeNull();

    const snoozed = await first.dismiss(observed.availableUpdateIdentity!);
    expect(snoozed.updateSnoozedUntil).toBe(now + UPDATE_SNOOZE_MS);
    await first.close();

    const reloaded = new UpdateCoordinator(options());
    expect((await reloaded.status()).updateSnoozedUntil).toBe(
      now + UPDATE_SNOOZE_MS,
    );
    // One unchanged source is enough to retain the exact-set acknowledgement;
    // one changed source is enough to bypass it without waiting for the other.
    await reloaded.checkInspire();
    expect((await reloaded.status()).updateSnoozedUntil).toBe(
      now + UPDATE_SNOOZE_MS,
    );

    latestInspireVersion = "1.2.0";
    await reloaded.checkInspire(true);
    const changed = await reloaded.status();
    expect(changed.availableUpdateIdentity).not.toBe(
      observed.availableUpdateIdentity,
    );
    expect(changed.updateSnoozedUntil).toBeNull();
    await expect(
      reloaded.dismiss(observed.availableUpdateIdentity!),
    ).rejects.toMatchObject({ status: 409 });
    await reloaded.close();
  });

  it("publishes acknowledgement as shared state instead of consuming display", async () => {
    const now = new Date(2026, 7, 21, 9, 0).getTime();
    const coordinator = new UpdateCoordinator({
      currentPiVersion: "0.84.2",
      inspireChecker: {
        check: async () => ({
          kind: "available" as const,
          update: {
            currentVersion: "1.0.0",
            latestVersion: "1.1.0",
            releaseUrl: "https://github.com/example/inspire/releases/v1.1.0",
          },
        }),
      },
      now: () => now,
    });
    await Promise.all([coordinator.checkInspire(), coordinator.checkPi()]);
    const before = await coordinator.status();
    const listener = vi.fn();
    coordinator.subscribe(listener);

    await coordinator.dismiss(before.availableUpdateIdentity!);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ updateSnoozedUntil: now + UPDATE_SNOOZE_MS }),
    );
    await coordinator.close();
  });
});
