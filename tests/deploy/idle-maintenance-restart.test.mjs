import { describe, expect, it, vi } from "vitest";
import {
  hostServicePath,
  restartIdleHost,
  terminalServicePath,
} from "../../deploy/systemd/control.mjs";
import {
  requestMaintenance,
  runIdleMaintenanceRestart,
} from "../../deploy/systemd/idle-maintenance-restart.mjs";
import { RuntimeController } from "../../server/runtime.js";

const root = "/synthetic/inspire";
const environment = { HOME: "/synthetic/home" };
const leaseId = "a".repeat(43);
const ready = { kind: "ready", leaseId, expiresAt: 30_000 };

function fixture({
  request,
  inspect = async () => {},
  issue = async () => ({ code: 0 }),
} = {}) {
  const requests = [];
  const run = vi.fn(async (args) => {
    if (args.includes("restart")) return issue();
    await inspect();
    const terminal = args.includes("inspire-terminal.service");
    return {
      code: 0,
      stderr: "",
      stdout: [
        "LoadState=loaded",
        `FragmentPath=${terminal ? terminalServicePath(environment) : hostServicePath(environment)}`,
        `WorkingDirectory=${root}`,
        `ExecStart={ path=${root}/inspire ; argv[]=${root}/inspire${terminal ? ` terminal-daemon --root ${root} --host 127.0.0.1 --port 4587` : ""} ; }`,
        `ExecStartPost={ path=${root}/inspire ; argv[]=${root}/inspire wait-ready ; }`,
        "Wants=inspire-terminal.service",
        "ActiveState=active",
      ].join("\n"),
    };
  });
  return {
    run,
    requests,
    execute: () =>
      runIdleMaintenanceRestart(
        {},
        root,
        (path, handoff) => restartIdleHost(path, handoff, { environment, run }),
        async (_state, action, owner) => {
          requests.push([action, owner]);
          if (request) return request(action, owner);
          if (!action) return ready;
          if (action === "commit") return { kind: "committed", leaseId: owner };
          return { kind: "released" };
        },
      ),
  };
}

const restarts = (run) =>
  run.mock.calls.filter(([args]) => args.includes("restart"));

describe.runIf(process.platform !== "win32")(
  "fenced maintenance runner",
  () => {
    it.each(["inspection", "post-commit"])(
      "keeps the real runtime safe across a delayed %s boundary",
      async (delayAt) => {
        vi.useFakeTimers();
        // These admission-only operations need no catalog, attachment, or Pi access.
        const runtime = new RuntimeController({}, {}, () => {
          throw new Error("No real worker allowed");
        });
        try {
          const test = fixture({
            inspect: async () => {
              if (delayAt === "inspection") {
                vi.advanceTimersByTime(31_000);
                // Admission reopened during the inspection, not after the old intent ended.
                await expect(runtime.deselectSession()).resolves.toMatchObject({
                  runState: "idle",
                });
              }
            },
            issue: async () => {
              vi.advanceTimersByTime(60_000);
              await expect(runtime.newSession(root)).rejects.toMatchObject({
                status: 503,
              });
              return { code: 0 };
            },
            request: async (action, owner) => {
              if (action === "commit")
                return runtime.commitMaintenanceRestart(owner);
              if (action === "release")
                return runtime.releaseMaintenanceRestart(owner);
              return runtime.reserveMaintenanceRestart();
            },
          });
          expect((await test.execute()).kind).toBe(
            delayAt === "inspection" ? "skipped" : "restarted",
          );
          expect(restarts(test.run)).toHaveLength(
            delayAt === "inspection" ? 0 : 1,
          );
          if (delayAt === "post-commit")
            expect(runtime.reserveMaintenanceRestart().kind).toBe("busy");
        } finally {
          await runtime.close();
          vi.useRealTimers();
        }
      },
    );

    it.each([
      null,
      { kind: "ready", expiresAt: Date.now() + 30_000 },
      { kind: "skipped", reason: "busy" },
    ])(
      "skips unavailable, legacy, and busy preparation without systemctl: %j",
      async (response) => {
        const test = fixture({ request: async () => response });
        expect((await test.execute()).kind).toBe("skipped");
        expect(test.run).not.toHaveBeenCalled();
      },
    );

    it("treats a timeout reading the commit response body as unknown, not approval", async () => {
      vi.useFakeTimers();
      const fetch = vi.fn(async (_url, { signal }) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("timed out")),
            );
          }),
      }));
      vi.stubGlobal("fetch", fetch);
      try {
        const response = requestMaintenance(
          { host: "127.0.0.1", port: 1234, token: "synthetic" },
          "commit",
          leaseId,
        );
        await vi.advanceTimersByTimeAsync(6_000);
        await expect(response).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ leaseId });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it.each(["absent", "inspection-error"])(
      "cancels before commit when service is %s",
      async (kind) => {
        const handoff = { commit: vi.fn(), release: vi.fn(async () => true) };
        const run = vi.fn(async () => {
          if (kind === "inspection-error") throw new Error("inspection failed");
          return { code: 0, stdout: "LoadState=not-found", stderr: "" };
        });
        expect(
          (await restartIdleHost(root, handoff, { environment, run })).kind,
        ).toBe("skipped");
        expect(handoff.commit).not.toHaveBeenCalled();
        expect(handoff.release).toHaveBeenCalledOnce();
        expect(restarts(run)).toHaveLength(0);
      },
    );

    it("commits after both inspections and issues exactly one restart", async () => {
      const test = fixture({
        request: async (action) => {
          if (!action) return ready;
          expect(test.run).toHaveBeenCalledTimes(2);
          return { kind: "committed", leaseId };
        },
      });
      expect(await test.execute()).toEqual({ kind: "restarted" });
      expect(restarts(test.run)).toHaveLength(1);
      expect(test.requests).toEqual([
        [undefined, undefined],
        ["commit", leaseId],
      ]);
    });

    it.each([
      null,
      { kind: "committed", leaseId: "b".repeat(43) },
      { kind: "skipped", reason: "lease-invalid" },
    ])(
      "never consumes an unconfirmed or mismatched commit: %j",
      async (response) => {
        const test = fixture({
          request: async (action) => {
            if (!action) return ready;
            return action === "commit" ? response : { kind: "released" };
          },
        });
        expect((await test.execute()).kind).toBe("skipped");
        expect(restarts(test.run)).toHaveLength(0);
        expect(test.requests.at(-1)).toEqual(["release", leaseId]);
      },
    );

    it.each(["before-release", "after-release"])(
      "cancels a timed-out commit delivered %s without later authorization",
      async (order) => {
        let phase = "preparing";
        let deliverCommit;
        const test = fixture({
          request: async (action) => {
            if (!action) return ready;
            if (action === "commit") {
              deliverCommit = () => {
                if (phase !== "preparing") return { kind: "skipped" };
                phase = "committed";
                return { kind: "committed", leaseId };
              };
              if (order === "before-release") deliverCommit();
              throw new Error("HTTP response lost");
            }
            phase = "released";
            return { kind: "released" };
          },
        });
        expect((await test.execute()).kind).toBe("skipped");
        if (order === "after-release")
          expect(deliverCommit()).toEqual({ kind: "skipped" });
        expect(phase).toBe("released");
        expect(restarts(test.run)).toHaveLength(0);
        expect(
          test.requests.filter(([action]) => action === "commit"),
        ).toHaveLength(1);
      },
    );

    it("releases a known failure to spawn", async () => {
      const test = fixture({ issue: async () => ({ code: 1, issued: false }) });
      expect(await test.execute()).toEqual({
        kind: "skipped",
        reason: "restart-not-issued",
      });
      expect(test.requests.at(-1)).toEqual(["release", leaseId]);
    });

    it.each([
      async () => ({ code: 1 }),
      async () => {
        throw new Error("lost systemctl");
      },
    ])(
      "retains committed admission for uncertain restart results",
      async (issue) => {
        const test = fixture({ issue });
        expect(await test.execute()).toEqual({
          kind: "recovery-required",
          reason: "restart-outcome-unknown",
        });
        expect(test.requests.some(([action]) => action === "release")).toBe(
          false,
        );
      },
    );

    it("reports an unconfirmed release instead of claiming admission reopened", async () => {
      const test = fixture({
        request: async (action) => (action ? null : ready),
      });
      expect(await test.execute()).toEqual({
        kind: "recovery-required",
        reason: "release-unconfirmed",
      });
      expect(restarts(test.run)).toHaveLength(0);
    });
  },
);
