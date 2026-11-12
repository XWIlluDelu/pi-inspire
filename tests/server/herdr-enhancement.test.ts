import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../../server/herdr-client.js";
import { HerdrEnhancement } from "../../server/herdr-enhancement.js";
import * as workerScopes from "../../server/herdr-process-group.js";
import { HerdrWorkerRegistry } from "../../server/herdr-worker-registry.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";

const directories: string[] = [];
const enhancements: HerdrEnhancement[] = [];
async function harness(enabled = false) {
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
  const checkScopes = vi
    .spyOn(workerScopes, "assertHerdrWorkerScopesAvailable")
    .mockResolvedValue();
  const enhancement = new HerdrEnhancement({ enabled, registry, client });
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
    checkScopes,
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
    it("skips Herdr in direct mode and reports availability for an on-demand server", async () => {
      const { enhancement, root, probe, checkScopes } = await harness();
      probe.mockResolvedValue({
        installed: true,
        running: false,
        compatible: null,
        version: null,
      });
      await enhancement.initialize();
      expect((await enhancement.createProcess({ cwd: root })).pid).toBeNull();
      expect(probe).not.toHaveBeenCalled();
      expect(checkScopes).not.toHaveBeenCalled();
      expect(await enhancement.status()).toMatchObject({
        enabled: false,
        ready: true,
        supported: true,
        installed: true,
        running: false,
        compatible: null,
      });
    });

    it("updates enabling readiness as installation and scope availability change", async () => {
      const { enhancement, probe, checkScopes } = await harness(true);
      try {
        await enhancement.initialize();
        for (const status of [
          { installed: false, running: false, compatible: null, version: null },
          { installed: true, running: true, compatible: false, version: "old" },
          {
            installed: true,
            running: false,
            compatible: null,
            version: null,
            issue: "Herdr server status could not be read",
          },
        ]) {
          probe.mockResolvedValueOnce(status);
          expect(await enhancement.status()).toMatchObject({
            ...status,
            ready: false,
          });
        }
        checkScopes.mockRejectedValueOnce(
          new Error("Scope manager unavailable"),
        );
        expect(await enhancement.status()).toMatchObject({
          ready: false,
          issue: "Scope manager unavailable",
        });
        const recovered = await enhancement.status();
        expect(recovered.ready).toBe(true);
        expect(recovered.issue).toBeUndefined();
        checkScopes.mockRejectedValue(new Error("Scope manager stopped"));
        expect(await enhancement.status()).toMatchObject({
          ready: false,
          issue: "Scope manager stopped",
        });
      } finally {
        checkScopes.mockRestore();
      }
    });

    it("reports only owned pane status until RPC retires, leaving cleanup to stop", async () => {
      const { enhancement, root, client, registry, closePane } =
        await harness(true);
      const pane = {
        serverId: "owned-server",
        workspaceId: "w1",
        tabId: "t1",
        paneId: "p1",
      };
      vi.spyOn(client, "createWorkerPane").mockResolvedValue(pane);
      const report = vi.spyOn(client, "reportWorker").mockResolvedValue();
      const worker = await enhancement.createProcess({ cwd: root });
      const startup = worker.start().catch((error: unknown) => error);
      try {
        await vi.waitFor(async () =>
          expect(await registry.list()).toHaveLength(1),
        );
        const idle = {
          sessionId: "session-one",
          runState: "idle",
          needsInput: false,
        } as const;
        enhancement.updateWorkerStatus(new PiRpcProcess({ cwd: root }), idle);
        const statuses = [
          { ...idle, state: "idle" },
          { ...idle, runState: "running", state: "working" },
          { ...idle, runState: "running", needsInput: true, state: "blocked" },
          { ...idle, runState: "compacting", state: "working" },
          { ...idle, sessionId: "session-two", state: "idle" },
        ] as const;
        for (const [index, { state, ...status }] of statuses.entries()) {
          enhancement.updateWorkerStatus(worker, status);
          await vi.waitFor(() =>
            expect(report).toHaveBeenCalledTimes(index + 1),
          );
          expect(report).toHaveBeenLastCalledWith(
            pane,
            expect.objectContaining({ state, sessionId: status.sessionId }),
          );
          if (index === 0) {
            enhancement.updateWorkerStatus(worker, status);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(report).toHaveBeenCalledOnce();
          }
        }

        worker.emit("exit", new Error("RPC retired before confirmed Pi exit"));
        enhancement.updateWorkerStatus(worker, idle);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(report).toHaveBeenCalledTimes(statuses.length);
        expect(closePane).not.toHaveBeenCalled();
        expect(await registry.list()).toHaveLength(1);
      } finally {
        await worker.stop();
        await startup;
      }
      expect(closePane).toHaveBeenCalledExactlyOnceWith(pane);
      expect(await registry.list()).toEqual([]);
    });

    it("never recovers a still-live Host's resources when a second Host starts on the same address", async () => {
      const { enhancement, root, lease, registry, restore, closePane } =
        await harness();
      const owned = await lease();
      await enhancement.initialize();
      await expect(enhancement.createProcess({ cwd: root })).rejects.toThrow(
        "Another Inspire Host",
      );
      expect(restore).not.toHaveBeenCalled();
      expect(closePane).not.toHaveBeenCalled();
      expect(await registry.list()).toEqual([owned]);
    });

    it("publishes the entire ownership release or leaves all leases owned", async () => {
      const { lease, registry } = await harness();
      const owned = await Promise.all([lease(), lease()]);
      const workers = await Promise.all(
        owned.map((item) => registry.grant(item, item.owner)),
      );
      await expect(
        registry.release(workers, () => {
          throw new Error("Release write failed");
        }),
      ).rejects.toThrow("Release write failed");
      expect(
        await Promise.all(workers.map((item) => registry.wasReleased(item))),
      ).toEqual([false, false]);
      await registry.release(workers);
      expect(
        await Promise.all(workers.map((item) => registry.wasReleased(item))),
      ).toEqual([true, true]);
      const [released] = workers;
      expect(
        await registry.wasReleased({
          ...released!,
          owner: { ...released!.owner, birth: "0" },
        }),
      ).toBe(false);
    });

    it("recovers only unreleased work after the old Host exits, even when released leases cannot be deleted", async () => {
      const { enhancement, root, registry, closePane } = await harness();
      await promisify(execFileCallback)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const { HerdrWorkerRegistry } = await import(process.argv[1]);
        const { mkdtemp } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const registry = new HerdrWorkerRegistry(process.argv[2]);
        const root = process.argv[3];
        const workers = [];
        for (const paneId of ["first", "second", "owned"]) {
          const lease = await registry.create(root, { serverId: "old", workspaceId: "w", tabId: "t", paneId }, await mkdtemp(join(root, "inspire-herdr-")));
          if (paneId !== "owned") workers.push(await registry.grant(lease, lease.owner));
        }
        await registry.release(workers);`,
        new URL("../../server/herdr-worker-registry.ts", import.meta.url).href,
        registry.directory,
        root,
      ]);
      const retained = (await registry.list()).filter((item) => item.group);
      expect(retained).toHaveLength(2);
      const remove = registry.remove.bind(registry);
      vi.spyOn(registry, "remove").mockImplementation(async (item) => {
        if (item.group)
          throw Object.assign(new Error("Read-only leases"), { code: "EROFS" });
        await remove(item);
      });
      const stop = vi.spyOn(workerScopes, "stopHerdrProcessGroup");
      await enhancement.initialize();
      expect(stop).not.toHaveBeenCalled();
      expect(closePane).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ paneId: "owned" }),
      );
      expect(await registry.list()).toEqual(retained);
      expect(
        await Promise.all(retained.map((item) => registry.wasReleased(item))),
      ).toEqual([true, true]);
      expect((await enhancement.createProcess({ cwd: root })).pid).toBeNull();
    });

    it("shares recovery retries and holds direct starts until stale ownership is cleared", async () => {
      const { enhancement, root, lease, registry, restore, closePane } =
        await harness();
      const owned = await lease();
      // Same PID, different birth identity: the recorded Host is gone.
      const old = { ...owned, owner: { ...owned.owner, birth: "0" } };
      await writeFile(
        join(registry.directory, `${old.id}.json`),
        JSON.stringify(old),
      );
      const list = vi
        .spyOn(registry, "list")
        .mockRejectedValueOnce(new Error("Temporary storage failure"));
      await enhancement.initialize();
      expect(await enhancement.status()).toMatchObject({
        ready: false,
        issue: expect.stringContaining("could not be verified"),
      });
      expect(list).toHaveBeenCalledOnce();

      let finishCleanup!: () => void;
      closePane.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
      );
      const admitted = vi.fn();
      const starts = [1, 2].map(() =>
        enhancement.createProcess({ cwd: root }).then((worker) => {
          admitted();
          return worker.pid;
        }),
      );
      try {
        await vi.waitFor(() =>
          expect(closePane).toHaveBeenCalledExactlyOnceWith(old.pane),
        );
        expect(restore).toHaveBeenCalledExactlyOnceWith({
          ...old.pane,
          cwd: root,
        });
        expect(admitted).not.toHaveBeenCalled();
      } finally {
        finishCleanup();
      }
      expect(await Promise.all(starts)).toEqual([null, null]);
      expect((await enhancement.status()).issue).toBeUndefined();
      await expect(
        readFile(join(registry.directory, `${old.id}.json`)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(old.launchDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });

      // Recovery has completed; a later lease belongs to this Host.
      await lease();
      expect((await enhancement.createProcess({ cwd: root })).pid).toBeNull();
      expect(list).toHaveBeenCalledTimes(2);
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
      await expect(enhancement.createProcess({ cwd: root })).rejects.toThrow(
        "Previous-version Herdr workers have no retained tool scope",
      );
      expect(await enhancement.status()).toMatchObject({
        ready: false,
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
      await expect(enhancement.createProcess({ cwd: root })).rejects.toThrow(
        "could not be verified",
      );
      expect(closePane).not.toHaveBeenCalled();
      expect(await enhancement.status()).toMatchObject({
        enabled: false,
        ready: false,
        issue: expect.stringContaining("could not be verified"),
      });
    });
  },
);
