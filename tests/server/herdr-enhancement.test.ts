import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../../server/herdr-client.js";
import { HerdrEnhancement } from "../../server/herdr-enhancement.js";
import * as workerScopes from "../../server/herdr-process-group.js";
import { HerdrWorkerObserver } from "../../server/herdr-worker-observer.js";
import { HerdrWorkerRegistry } from "../../server/herdr-worker-registry.js";

const directories: string[] = [];
const enhancements: HerdrEnhancement[] = [];
async function harness(enabled = false, mock = false) {
  const root = await mkdtemp(join(tmpdir(), "inspire-enhancement-test-"));
  directories.push(root);
  const registry = new HerdrWorkerRegistry(join(root, "ownership"));
  const client = new HerdrClient({ binary: "/this-test-must-not-run-herdr" });
  const probe = vi.spyOn(client, "probe").mockResolvedValue({
    installed: true,
    running: true,
    compatible: true,
    version: "0.9.1",
  });
  const restore = vi.spyOn(client, "restoreOwnedPane");
  const closePane = vi.spyOn(client, "closePane").mockResolvedValue();
  const enhancement = new HerdrEnhancement({ enabled, mock, registry, client });
  enhancements.push(enhancement);
  const lease = async () => {
    const launchDirectory = await mkdtemp(join(root, "inspire-herdr-"));
    return registry.create(
      root,
      {
        serverId: "old-daemon",
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
      },
      launchDirectory,
    );
  };
  return {
    root,
    registry,
    client,
    probe,
    restore,
    closePane,
    enhancement,
    lease,
  };
}

afterEach(async () => {
  await Promise.all(
    enhancements.splice(0).map((enhancement) => enhancement.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")(
  "Herdr enhancement admission",
  () => {
    it("keeps the disabled path free of Herdr calls; explicit status inspection is read-only", async () => {
      const { enhancement, root, probe, restore, closePane } = await harness();
      await enhancement.initialize();
      expect(enhancement.createProcess({ cwd: root }).pid).toBeNull();
      expect(probe).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(closePane).not.toHaveBeenCalled();
      expect(await enhancement.status()).toMatchObject({
        enabled: false,
        supported: true,
        installed: true,
      });
      expect(probe).toHaveBeenCalledOnce();
    });

    it("reports unavailable scopes, retries failures, and reuses a successful check for workers", async () => {
      const { enhancement, root, client } = await harness(true);
      const check = vi
        .spyOn(workerScopes, "assertHerdrWorkerScopesAvailable")
        .mockRejectedValueOnce(new Error("Scope manager unavailable"))
        .mockResolvedValue();
      vi.spyOn(client, "createWorkerPane").mockRejectedValue(
        new Error("Test stops at pane allocation"),
      );
      try {
        await enhancement.initialize();
        expect(await enhancement.status()).toMatchObject({
          issue: "Scope manager unavailable",
        });
        for (let i = 0; i < 2; i++) {
          const worker = enhancement.createProcess({ cwd: root });
          await expect(worker.start()).rejects.toThrow(
            "Test stops at pane allocation",
          );
          await worker.stop();
        }
        expect(check).toHaveBeenCalledTimes(2);
        check.mockRejectedValue(new Error("Scope manager stopped"));
        expect(await enhancement.status()).toMatchObject({
          issue: "Scope manager stopped",
        });
        expect(check).toHaveBeenCalledTimes(3);
      } finally {
        check.mockRestore();
      }
    });

    it("projects only its own live worker and disposes projection on retirement", async () => {
      const { enhancement, root } = await harness(true);
      const projection = {
        update: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };
      const observe = vi
        .spyOn(HerdrWorkerObserver.prototype, "observe")
        .mockReturnValue(projection);
      try {
        await enhancement.initialize();
        const rpc = enhancement.createProcess({ cwd: root });
        const status = {
          sessionId: "session-one",
          runState: "running",
          needsInput: true,
        } as const;
        enhancement.updateWorkerStatus(rpc, status);
        expect(projection.update).toHaveBeenCalledExactlyOnceWith(status);
        rpc.emit("exit", new Error("RPC retired before confirmed Pi exit"));
        expect(projection.dispose).toHaveBeenCalledOnce();
        enhancement.updateWorkerStatus(rpc, status);
        expect(projection.update).toHaveBeenCalledOnce();
      } finally {
        observe.mockRestore();
      }
    });

    it("never recovers a still-live Host's resources when a second Host starts on the same address", async () => {
      const { enhancement, root, lease, registry, restore, closePane } =
        await harness();
      const owned = await lease();
      await enhancement.initialize();
      expect(() => enhancement.createProcess({ cwd: root })).toThrow(
        "Another Inspire Host",
      );
      expect(restore).not.toHaveBeenCalled();
      expect(closePane).not.toHaveBeenCalled();
      expect(await registry.list()).toEqual([owned]);
    });

    it("fences admission during recovery even when switching back to direct mode", async () => {
      const { enhancement, root, lease, registry, restore, closePane } =
        await harness();
      const owned = await lease();
      // The recorded Host incarnation is gone; no Pi grant was ever issued.
      // Deliberately keep its numeric PID to exercise birth-identity reuse.
      const old = { ...owned, owner: { ...owned.owner, birth: "0" } };
      await writeFile(
        join(registry.directory, `${old.id}.json`),
        JSON.stringify(old),
      );
      const recovering = enhancement.initialize();
      expect(() => enhancement.createProcess({ cwd: root })).toThrow(
        "still stopping",
      );
      await recovering;
      expect(restore).toHaveBeenCalledWith({ ...old.pane, cwd: root });
      expect(closePane).toHaveBeenCalledWith(old.pane);
      expect(await registry.list()).toEqual([]);
      await expect(
        readFile(join(owned.launchDirectory, "launch.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(enhancement.createProcess({ cwd: root }).pid).toBeNull();
    });

    it("retains legacy granted leases rather than claiming detached tools exited", async () => {
      const { enhancement, root, lease, registry, closePane } = await harness();
      const owned = await lease();
      const legacy = {
        ...owned,
        owner: { ...owned.owner, birth: "0" },
        group: owned.owner,
      };
      await writeFile(
        join(registry.directory, `${legacy.id}.json`),
        JSON.stringify(legacy),
      );
      await enhancement.initialize();
      expect(() => enhancement.createProcess({ cwd: root })).toThrow(
        "Previous-version Herdr workers have no retained tool scope",
      );
      expect(await enhancement.status()).toMatchObject({
        issue: expect.stringContaining("reboot this machine"),
      });
      expect(closePane).not.toHaveBeenCalled();
      expect(await registry.list()).toEqual([legacy]);
    });

    it("refuses unverifiable ownership instead of silently starting a direct writer", async () => {
      const { enhancement, root, lease, registry, closePane } = await harness();
      await lease();
      await chmod(registry.directory, 0o755);
      await enhancement.initialize();
      expect(() => enhancement.createProcess({ cwd: root })).toThrow(
        "could not be verified",
      );
      expect(closePane).not.toHaveBeenCalled();
      expect(await enhancement.status()).toMatchObject({
        enabled: false,
        issue: expect.stringContaining("could not be verified"),
      });
    });

    it("does not inspect or recover real ownership in mock mode", async () => {
      const { enhancement, root, registry, lease, probe, restore } =
        await harness(true, true);
      await lease();
      const list = vi.spyOn(registry, "list");
      await enhancement.initialize();
      expect(await enhancement.status()).toMatchObject({
        enabled: false,
        supported: false,
      });
      expect(enhancement.createProcess({ cwd: root }).pid).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });
  },
);
